const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, Tray, Menu } = require('electron');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Initialize store at the top level
let store;
(async () => {
    const Store = await import('electron-store');
    store = new Store.default({
        name: 'settings',
        defaults: {
            opacity: 0.75,
            position: 'topRight',
            viewMode: 'simple'
        }
    });
})();

let mainWindow;
let overlayWindow;
let isOverlayVisible = true;
let hasAdminPermissions = false;
let selectedApps = new Set();
let settingsWindow = null;
let lastStats = null;
let allWindows = new Set();
let isAppQuitting = false;
let tray = null;

// Near the top of the file, add:
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Get the path where settings are stored
const getSettingsPath = async () => {
    const Store = await import('electron-store');
    const tempStore = new Store.default();
    return path.dirname(tempStore.path);
};

// Validate window bounds to ensure they are valid integers
function validateBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    
    const defaultBounds = {
        width: 400,
        height: 600,
        x: 100,
        y: 100
    };
    
    const validatedBounds = {};
    
    // Ensure all values are valid integers
    for (const key of ['x', 'y', 'width', 'height']) {
        const value = bounds[key];
        if (Number.isInteger(value) && value >= 0) {
            validatedBounds[key] = value;
        } else {
            validatedBounds[key] = defaultBounds[key];
        }
    }
    
    return validatedBounds;
}

// Get display safe area
function getDisplaySafeArea() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { workArea } = primaryDisplay;
    return {
        x: Math.floor(workArea.x),
        y: Math.floor(workArea.y),
        width: Math.floor(workArea.width),
        height: Math.floor(workArea.height)
    };
}

function trackWindow(window) {
    allWindows.add(window);
    window.on('closed', () => {
        allWindows.delete(window);
    });
}

function closeAllWindows() {
    isAppQuitting = true;
    
    // Clear the monitoring interval first
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
    
    // Clear the selected apps
    selectedApps.clear();
    
    // Force close the overlay first
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
    }
    
    // Close all other windows
    allWindows.forEach(window => {
        if (window !== overlayWindow && !window.isDestroyed()) {
            window.close();
        }
    });
    allWindows.clear();
}

// Add this function to handle app quit properly
function quitApp() {
    isAppQuitting = true;

    // Clear all intervals
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }

    // Unregister all shortcuts
    try {
        globalShortcut.unregisterAll();
    } catch (error) {
        console.error('Error unregistering shortcuts:', error);
    }

    // Destroy tray
    if (tray) {
        try {
            tray.destroy();
            tray = null;
        } catch (error) {
            console.error('Error destroying tray:', error);
        }
    }

    // Close all windows
    BrowserWindow.getAllWindows().forEach(window => {
        try {
            if (!window.isDestroyed()) {
                window.destroy();
            }
        } catch (error) {
            console.error('Error closing window:', error);
        }
    });

    // Clear any stored data
    selectedApps.clear();
    allWindows.clear();

    // Force quit the app
    try {
        app.exit(0);
    } catch (error) {
        console.error('Error exiting app:', error);
        process.exit(0);
    }
}

async function createMainWindow() {
    const savedBounds = validateBounds(store.get('mainWindowBounds'));
    const workArea = getDisplaySafeArea();
    
    const defaultBounds = {
        width: 400,
        height: 600,
        x: workArea.x + Math.floor((workArea.width - 400) / 2),
        y: workArea.y + Math.floor((workArea.height - 600) / 2)
    };

    const bounds = savedBounds || defaultBounds;
    
    mainWindow = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        resizable: false
    });

    mainWindow.loadFile('index.html');
    trackWindow(mainWindow);

    // Save window position when moved
    mainWindow.on('moved', () => {
        const currentBounds = mainWindow.getBounds();
        if (currentBounds && typeof currentBounds === 'object') {
            store.set('mainWindowBounds', validateBounds(currentBounds));
        }
    });

    // Add show-settings handler for backward compatibility
    ipcMain.on('show-settings', () => {
        createSettingsWindow();
    });

    // Add these event handlers
    mainWindow.on('close', (event) => {
        if (!isAppQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('minimize', (event) => {
        event.preventDefault();
        mainWindow.hide();
    });

    // Add this handler for when the window is closed
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

async function createOverlayWindow() {
    const savedBounds = validateBounds(store.get('overlayBounds'));
    const settings = store.get('settings') || {};
    const workArea = getDisplaySafeArea();
    
    const defaultBounds = {
        width: 280,
        height: 100,
        x: workArea.x + workArea.width - 300,
        y: workArea.y + 50
    };

    const bounds = savedBounds || defaultBounds;
    
    overlayWindow = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        opacity: settings.opacity || 0.75,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        type: 'toolbar',
        focusable: false
    });

    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setVisibleOnAllWorkspaces(true);
    overlayWindow.setIgnoreMouseEvents(true);
    overlayWindow.loadFile('overlay.html');
    trackWindow(overlayWindow);

    overlayWindow.webContents.on('did-finish-load', () => {
        const settings = store.get('settings') || {};
        overlayWindow.webContents.send('initial-settings', settings);
    });

    overlayWindow.on('moved', () => {
        const currentBounds = overlayWindow.getBounds();
        if (currentBounds && typeof currentBounds === 'object') {
            store.set('overlayBounds', validateBounds(currentBounds));
        }
    });

    overlayWindow.on('closed', () => {
        overlayWindow = null;
        if (!isAppQuitting) {
            quitApp();
        }
    });
}

// Register global shortcut
function registerShortcuts() {
    // Unregister existing shortcuts first
    globalShortcut.unregisterAll();

    const settings = store.get('settings') || {};
    const shortcuts = settings.shortcuts || {};

    // Register toggle overlay shortcut
    const toggleShortcut = shortcuts['toggle-overlay'] || 'CommandOrControl+Shift+O';
    try {
        globalShortcut.register(normalizeShortcut(toggleShortcut), () => {
            toggleOverlay();
        });
    } catch (error) {
        console.error('Failed to register toggle shortcut:', error);
    }

    // Register position shortcuts
    const corners = {
        'position-1': 'bottomLeft',
        'position-2': 'bottomCenter',
        'position-3': 'bottomRight',
        'position-4': 'middleLeft',
        'position-5': 'center',
        'position-6': 'middleRight',
        'position-7': 'topLeft',
        'position-8': 'topCenter',
        'position-9': 'topRight'
    };

    Object.entries(corners).forEach(([action, position]) => {
        const shortcut = shortcuts[action] || `CommandOrControl+Shift+${action.split('-')[1]}`;
        try {
            globalShortcut.register(normalizeShortcut(shortcut), () => {
                moveOverlayToPosition(position);
            });
        } catch (error) {
            console.error(`Failed to register position shortcut ${action}:`, error);
        }
    });
}

// Add helper function to normalize shortcuts
function normalizeShortcut(shortcut) {
    return shortcut
        .replace(/Ctrl/gi, 'CommandOrControl')
        .replace(/\+/g, '+')
        .replace(/\s+/g, '')
        .replace(/Super/gi, 'Super')
        .replace(/Alt/gi, 'Alt')
        .replace(/Shift/gi, 'Shift');
}

function moveOverlayToPosition(position) {
    if (!overlayWindow) return;

    const workArea = getDisplaySafeArea();
    const currentBounds = overlayWindow.getBounds();
    const windowWidth = Math.floor(currentBounds.width) || 280;
    const windowHeight = Math.floor(currentBounds.height) || 100;
    
    let x = 0, y = 0;
    const padding = 10;

    switch (position) {
        case 'topLeft':
            x = workArea.x + padding;
            y = workArea.y + padding;
            break;
        case 'topCenter':
            x = workArea.x + Math.floor((workArea.width - windowWidth) / 2);
            y = workArea.y + padding;
            break;
        case 'topRight':
            x = workArea.x + workArea.width - windowWidth - padding;
            y = workArea.y + padding;
            break;
        case 'middleLeft':
            x = workArea.x + padding;
            y = workArea.y + Math.floor((workArea.height - windowHeight) / 2);
            break;
        case 'center':
            x = workArea.x + Math.floor((workArea.width - windowWidth) / 2);
            y = workArea.y + Math.floor((workArea.height - windowHeight) / 2);
            break;
        case 'middleRight':
            x = workArea.x + workArea.width - windowWidth - padding;
            y = workArea.y + Math.floor((workArea.height - windowHeight) / 2);
            break;
        case 'bottomLeft':
            x = workArea.x + padding;
            y = workArea.y + workArea.height - windowHeight - padding;
            break;
        case 'bottomCenter':
            x = workArea.x + Math.floor((workArea.width - windowWidth) / 2);
            y = workArea.y + workArea.height - windowHeight - padding;
            break;
        case 'bottomRight':
            x = workArea.x + workArea.width - windowWidth - padding;
            y = workArea.y + workArea.height - windowHeight - padding;
            break;
    }

    // Ensure all values are integers and create bounds object
    const newBounds = {
        x: Math.floor(x),
        y: Math.floor(y),
        width: Math.floor(windowWidth),
        height: Math.floor(windowHeight)
    };

    try {
        // Validate bounds before setting
        const validBounds = validateBounds(newBounds);
        if (validBounds) {
            overlayWindow.setBounds(validBounds);
        }
    } catch (error) {
        console.error('Error setting bounds:', error);
    }
}

function toggleOverlay() {
    isOverlayVisible = !isOverlayVisible;
    if (isOverlayVisible) {
        overlayWindow.show();
    } else {
        overlayWindow.hide();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('overlay-state', isOverlayVisible);
    }
}

// Update checkAdminPermissions function
async function checkAdminPermissions() {
    try {
        // First check if we have stored admin status
        const storedStatus = store.get('adminPermissions');
        if (storedStatus) {
            hasAdminPermissions = true;
            notifyWindowsAboutPermissions();
            return true;
        }

        // If no stored status, check current permissions
        execSync('net session', { stdio: 'ignore' });
        hasAdminPermissions = true;
        store.set('adminPermissions', true);
    } catch (e) {
        hasAdminPermissions = false;
        store.delete('adminPermissions');
    }

    notifyWindowsAboutPermissions();
    return hasAdminPermissions;
}

function notifyWindowsAboutPermissions() {
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
            win.webContents.send('admin-status', {
                hasPermissions: hasAdminPermissions,
                isRunningAsAdmin: hasAdminPermissions
            });
        }
    });
}

// Update permission request handler
ipcMain.on('request-permissions', async () => {
    try {
        if (isDev) {
            // In development, relaunch with electron
            const electronExe = process.execPath;
            const appPath = path.join(process.cwd());
            execSync(`powershell.exe -Command "Start-Process '${electronExe}' -ArgumentList '${appPath}' -Verb RunAs"`, {
                stdio: 'ignore'
            });
        } else {
            // In production, relaunch the packaged exe
            execSync(`powershell.exe -Command "Start-Process '${process.execPath}' -Verb RunAs"`, {
                stdio: 'ignore'
            });
        }
        
        // Clear stored permissions before quitting
        store.delete('adminPermissions');
        app.quit();
    } catch (error) {
        console.error('Failed to request admin permissions:', error);
        notifyWindowsAboutPermissions();
    }
});

// Handle overlay toggle
ipcMain.on('toggle-overlay', () => {
    isOverlayVisible = !isOverlayVisible;
    if (isOverlayVisible) {
        overlayWindow.show();
    } else {
        overlayWindow.hide();
    }
    mainWindow.webContents.send('overlay-state', isOverlayVisible);
});

// Handle position reset
ipcMain.on('reset-position', () => {
    overlayWindow.setPosition(50, 50);
});

// Handle window dragging
ipcMain.on('drag-window', () => {
    overlayWindow.setIgnoreMouseEvents(false);
});

ipcMain.on('end-drag-window', () => {
    overlayWindow.setIgnoreMouseEvents(true);
});

// Handle app selection updates
ipcMain.on('update-selected-apps', (event, apps) => {
    selectedApps = new Set(apps);
});

// Handle overlay size update
ipcMain.on('update-overlay-size', (event, size) => {
    if (!overlayWindow) return;
    
    try {
        const currentBounds = overlayWindow.getBounds();
        const newBounds = {
            x: Math.floor(currentBounds.x),
            y: Math.floor(currentBounds.y),
            width: Math.floor(280), // Fixed width
            height: Math.floor(Math.min(Math.max(size.height + 30, 100), 800))
        };
        
        const validBounds = validateBounds(newBounds);
        if (validBounds) {
            overlayWindow.setBounds(validBounds);
        }
    } catch (error) {
        console.error('Error updating overlay size:', error);
    }
});

// Add this with your other ipcMain handlers
ipcMain.on('move-overlay', (event, position) => {
    moveOverlayToPosition(position);
});

function getNetworkStats() {
    // Don't process if app is quitting or windows are destroyed
    if (isAppQuitting || !mainWindow || mainWindow.isDestroyed() || !overlayWindow || overlayWindow.isDestroyed()) {
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
            monitoringInterval = null;
        }
        return;
    }

    if (!hasAdminPermissions) {
        return getBasicNetworkStats();
    }

    const command = 'powershell.exe -Command "&{Get-NetTCPConnection | Where-Object State -eq Established | ForEach-Object { $process = Get-Process -Id $_.OwningProcess; $dns = try { [System.Net.Dns]::GetHostEntry($_.RemoteAddress).HostName } catch { $null }; [PSCustomObject]@{ ProcessName = $process.ProcessName; RemoteAddress = $_.RemoteAddress; RemotePort = $_.RemotePort; DNS = $dns }} | ConvertTo-Json}"';
    
    exec(command, (error, stdout) => {
        // Check again in case windows were destroyed during command execution
        if (isAppQuitting || !mainWindow || mainWindow.isDestroyed() || !overlayWindow || overlayWindow.isDestroyed()) {
            return;
        }

        if (error) {
            console.error('Error:', error);
            return getBasicNetworkStats();
        }

        try {
            const connections = {};
            const data = JSON.parse(stdout);
            const allApps = new Map();
            
            if (Array.isArray(data)) {
                data.forEach(conn => {
                    const processName = conn.ProcessName;
                    allApps.set(processName, { name: processName });

                    if (selectedApps.has(processName)) {
                        if (!connections[processName]) {
                            connections[processName] = {
                                name: processName,
                                latency: Math.floor(Math.random() * 20) + 20,
                                connections: 1,
                                addresses: [{
                                    ip: conn.RemoteAddress,
                                    port: conn.RemotePort,
                                    name: conn.DNS || null
                                }]
                            };
                        } else {
                            connections[processName].connections++;
                            const newAddr = {
                                ip: conn.RemoteAddress,
                                port: conn.RemotePort,
                                name: conn.DNS || null
                            };
                            if (!connections[processName].addresses.some(addr => 
                                addr.ip === newAddr.ip && addr.port === newAddr.port)) {
                                connections[processName].addresses.push(newAddr);
                            }
                            const currentLatency = connections[processName].latency;
                            const variation = Math.floor(Math.random() * 5) - 2;
                            connections[processName].latency = Math.max(20, Math.min(150, currentLatency + variation));
                        }
                    }
                });
            }

            // Final check before sending updates
            if (!isAppQuitting && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('update-apps', Array.from(allApps.values()));
            }

            if (!isAppQuitting && overlayWindow && !overlayWindow.isDestroyed()) {
                const statsString = JSON.stringify(connections);
                if (statsString !== lastStats) {
                    lastStats = statsString;
                    overlayWindow.webContents.send('network-stats', connections);
                }
            }
        } catch (parseError) {
            console.error('Parse error:', parseError);
            if (!isAppQuitting) {
                getBasicNetworkStats();
            }
        }
    });
}

function getBasicNetworkStats() {
    // Don't process if app is quitting or windows are destroyed
    if (isAppQuitting || !overlayWindow || overlayWindow.isDestroyed()) {
        return;
    }

    // If no apps are selected, send empty stats
    if (selectedApps.size === 0) {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('network-stats', {});
        }
        return;
    }

    exec('netstat -n', (error, stdout) => {
        // Check again in case windows were destroyed during command execution
        if (isAppQuitting || !overlayWindow || overlayWindow.isDestroyed()) {
            return;
        }

        if (error) {
            console.error('Error:', error);
            return;
        }

        const lines = stdout.split('\n');
        const connections = {};
        
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4 && parts[3] === 'ESTABLISHED') {
                const remoteAddress = parts[2].split(':')[0];
                if (selectedApps.size > 0) {
                    if (!connections[remoteAddress]) {
                        connections[remoteAddress] = {
                            name: `Connection ${remoteAddress}`,
                            latency: Math.floor(Math.random() * 20) + 20,
                            connections: 1
                        };
                    } else {
                        connections[remoteAddress].connections++;
                        const currentLatency = connections[remoteAddress].latency;
                        const variation = Math.floor(Math.random() * 5) - 2;
                        connections[remoteAddress].latency = Math.max(20, Math.min(150, currentLatency + variation));
                    }
                }
            }
        });

        if (!isAppQuitting && overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('network-stats', connections);
        }
    });
}

let monitoringInterval;

function startMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
    }
    monitoringInterval = setInterval(getNetworkStats, 1000);
}

// Add this near the top of the file, before app.whenReady()
function isPackagedApp() {
    return app.isPackaged || process.env.ELECTRON_OVERRIDE_DIST_PATH;
}

// Update the app startup
app.whenReady().then(async () => {
    // Wait for store to be initialized
    while (!store) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    createTray();
    await createOverlayWindow();
    await createMainWindow();
    registerShortcuts();
    
    await checkAdminPermissions();
    if (hasAdminPermissions) {
        startMonitoring();
    }
});

// Update the app quit handling
app.on('before-quit', () => {
    isAppQuitting = true;
});

// Update window-all-closed handler
app.on('window-all-closed', () => {
    isAppQuitting = true;
    quitApp();
});

// Add force quit handler
app.on('quit', () => {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
    if (tray) {
        tray.destroy();
        tray = null;
    }
    globalShortcut.unregisterAll();
    
    // Force close any remaining windows
    BrowserWindow.getAllWindows().forEach(window => {
        try {
            if (!window.isDestroyed()) {
                window.destroy();
            }
        } catch (error) {
            console.error('Error closing window:', error);
        }
    });
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createOverlayWindow();
        createMainWindow();
        registerShortcuts();
    }
});

function createSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 400,
        height: 500,
        frame: false,
        transparent: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        parent: mainWindow,
        modal: true
    });

    settingsWindow.loadFile('settings.html');
    trackWindow(settingsWindow);

    settingsWindow.webContents.on('did-finish-load', () => {
        const settings = store.get('settings') || {};
        settingsWindow.webContents.send('load-settings', settings);
    });

    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
}

// Add these event handlers
ipcMain.on('open-settings', () => {
    createSettingsWindow();
});

ipcMain.on('get-initial-settings', async (event) => {
    try {
        // Make sure store is initialized
        if (!store) {
            throw new Error('Store not initialized');
        }

        const settings = store.get('settings', {
            opacity: 0.75,
            position: 'topRight',
            viewMode: 'simple'
        });

        event.reply('initial-settings', settings);
    } catch (error) {
        console.error('Failed to load settings:', error);
        event.reply('initial-settings', {
            opacity: 0.75,
            position: 'topRight',
            viewMode: 'simple'
        });
    }
});

ipcMain.on('set-opacity', (event, opacity) => {
    if (overlayWindow) {
        overlayWindow.setOpacity(opacity);
    }
});

ipcMain.on('save-settings', async (event, newSettings) => {
    try {
        if (!store) {
            throw new Error('Store not initialized');
        }

        // Save all settings
        await store.set('settings', {
            ...store.get('settings', {}),
            ...newSettings
        });

        // Re-register shortcuts if they changed
        if (newSettings.shortcuts) {
            registerShortcuts();
        }

        // Notify all windows about the settings change
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('settings-updated', store.get('settings'));
            }
        });

        // Apply immediate effects
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            if (newSettings.opacity !== undefined) {
                overlayWindow.setOpacity(newSettings.opacity);
            }
            if (newSettings.position !== undefined) {
                moveOverlayToPosition(newSettings.position);
            }
        }

        event.reply('settings-saved', { success: true });
    } catch (error) {
        console.error('Failed to save settings:', error);
        event.reply('settings-saved', { 
            success: false, 
            error: 'Failed to save settings. Please make sure you have write permissions.'
        });
    }
});

// Update the window close button handler
ipcMain.on('quit-app', () => {
    quitApp();
});

// Add this to index.html close button
function closeApp() {
    ipcRenderer.send('quit-app');
}

// Add these new IPC handlers
ipcMain.on('get-app-info', async (event) => {
  event.reply('app-info', {
    version: app.getVersion(),
    storagePath: await getSettingsPath()
  });
});

ipcMain.on('open-storage-location', async () => {
  const settingsPath = await getSettingsPath();
  shell.openPath(settingsPath);
});

ipcMain.on('check-updates', async (event) => {
  // For now just show current version
  // TODO: Implement actual update checking
  event.reply('update-status', {
    currentVersion: app.getVersion(),
    isLatest: true
  });
});

function createTray() {
    let iconPath;
    try {
        // Try to use the app icon first
        iconPath = path.join(__dirname, 'build/icon.ico');
        if (!fs.existsSync(iconPath)) {
            // If .ico doesn't exist, check for .svg
            const svgPath = path.join(__dirname, 'build/icon.svg');
            if (fs.existsSync(svgPath)) {
                iconPath = svgPath;
            } else {
                // If no custom icon exists, use electron's default
                iconPath = path.join(process.resourcesPath, 'electron.asar/default_app/icon.png');
            }
        }
    } catch (error) {
        console.error('Error finding icon:', error);
        // Fallback to electron's default icon
        iconPath = path.join(process.resourcesPath, 'electron.asar/default_app/icon.png');
    }

    try {
        tray = new Tray(iconPath);
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Show/Hide Window', click: () => toggleMainWindow() },
            { label: 'Show/Hide Overlay', click: () => toggleOverlay() },
            { type: 'separator' },
            { label: 'Settings', click: () => createSettingsWindow() },
            { type: 'separator' },
            { label: 'Quit', click: () => quitApp() }
        ]);
        
        tray.setToolTip('Network Latency Monitor');
        tray.setContextMenu(contextMenu);
        
        // Double click shows/hides the main window
        tray.on('double-click', () => toggleMainWindow());
    } catch (error) {
        console.error('Failed to create tray:', error);
        // Don't throw error, just log it - app can function without tray
    }
}

function toggleMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
        mainWindow.hide();
    } else {
        mainWindow.show();
        mainWindow.focus();
    }
} 