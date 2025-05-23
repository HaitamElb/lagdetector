const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell } = require('electron');
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
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
    closeAllWindows();
    app.quit();
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
        }
    });

    overlayWindow.setIgnoreMouseEvents(true);
    overlayWindow.loadFile('overlay.html');
    trackWindow(overlayWindow);

    // Send initial settings when overlay loads
    overlayWindow.webContents.on('did-finish-load', () => {
        const settings = store.get('settings') || {};
        overlayWindow.webContents.send('initial-settings', settings);
    });

    // Save overlay position when moved
    overlayWindow.on('moved', () => {
        const currentBounds = overlayWindow.getBounds();
        if (currentBounds && typeof currentBounds === 'object') {
            store.set('overlayBounds', validateBounds(currentBounds));
        }
    });

    // When overlay closes, clean up everything
    overlayWindow.on('closed', () => {
        if (!isAppQuitting) {
            quitApp();
        }
    });
}

// Register global shortcut
function registerShortcuts() {
    // Toggle overlay visibility with Ctrl+Shift+O
    globalShortcut.register('CommandOrControl+Shift+O', () => {
        toggleOverlay();
    });

    // Move overlay to different corners with Ctrl+Shift+[1-9]
    const corners = {
        '1': 'bottomLeft',
        '2': 'bottomCenter',
        '3': 'bottomRight',
        '4': 'middleLeft',
        '5': 'center',
        '6': 'middleRight',
        '7': 'topLeft',
        '8': 'topCenter',
        '9': 'topRight'
    };

    Object.entries(corners).forEach(([key, position]) => {
        globalShortcut.register(`CommandOrControl+Shift+${key}`, () => {
            moveOverlayToPosition(position);
        });
    });
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
    mainWindow.webContents.send('overlay-state', isOverlayVisible);
}

// Replace the checkAdminPermissions function
async function checkAdminPermissions() {
    try {
        // Try to execute a command that requires admin rights
        execSync('net session', { stdio: 'ignore' });
        hasAdminPermissions = true;
    } catch (e) {
        hasAdminPermissions = false;
    }

    // Store permission status
    store.set('adminPermissions', hasAdminPermissions);

    // Notify windows about permission status
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
            win.webContents.send('admin-status', {
                hasPermissions: hasAdminPermissions,
                isRunningAsAdmin: hasAdminPermissions
            });
        }
    });

    return hasAdminPermissions;
}

// Replace the permission request handler
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
        
        // Quit the current instance
        app.quit();
    } catch (error) {
        console.error('Failed to request admin permissions:', error);
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('permissions-denied', {
                    error: 'Failed to get admin permissions. Please try running the app as administrator.'
                });
            }
        });
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
    
    // Create overlay first as it's our main window
    await createOverlayWindow();
    await createMainWindow();
    registerShortcuts();
    
    await checkAdminPermissions();
    if (hasAdminPermissions) {
        startMonitoring();
    }
});

app.on('will-quit', () => {
    quitApp();
});

app.on('window-all-closed', () => {
    quitApp();
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
        width: 800,
        height: 700,
        frame: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    settingsWindow.loadFile('settings.html');
    trackWindow(settingsWindow);

    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });

    // Load settings
    settingsWindow.webContents.on('did-finish-load', () => {
        const settings = store.get('settings') || {};
        settingsWindow.webContents.send('load-settings', settings);
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
        // Make sure store is initialized
        if (!store) {
            throw new Error('Store not initialized');
        }

        // Save all settings
        await store.set('settings', {
            ...store.get('settings', {}),
            ...newSettings
        });

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

        // Send success response
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