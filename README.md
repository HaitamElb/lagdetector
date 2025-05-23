# Network Latency Monitor

![Version](https://img.shields.io/badge/version-1.0.0-green.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-windows-lightgrey.svg)
![Electron](https://img.shields.io/badge/electron-28.1.0-blue.svg)

A powerful, open-source network latency monitoring solution for Windows. Inspired by gaming overlays but designed for everyone - from gamers to developers to system administrators. Monitor real-time network latency for any application with a beautiful, non-intrusive overlay.

<div align="center">
  <img src="build/icon.svg" width="120" />
</div>

## ✨ Features

- 🖥️ **Real-time Monitoring**: Track network latency for any Windows application
- 🎯 **Smart Overlay**: Non-intrusive, customizable overlay that stays on top
- 🎨 **Modern Design**: Apple-inspired minimalist interface with frosted glass effects
- ⌨️ **Global Shortcuts**: Quick access with customizable keyboard shortcuts
- 🔒 **Secure**: Proper permission handling for network monitoring
- 💾 **Persistent Settings**: Your preferences are saved automatically

## 🚀 Quick Start

1. Download the latest release from the [releases page](https://github.com/HaitamElb/lagdetector/releases)
2. Run the installer
3. Launch the app
4. Grant administrator permissions when prompted (required for detailed network monitoring)

## ⌨️ Keyboard Shortcuts

- `Ctrl+Shift+O`: Toggle overlay visibility
- `Ctrl+Shift+[1-9]`: Quick position overlay (numpad positions)

## 🛠️ Development

### Prerequisites

- Node.js 18+
- npm or yarn
- Windows 10/11

### Setup

```bash
# Clone the repository
git clone https://github.com/HaitamElb/lagdetector.git

# Navigate to the directory
cd lagdetector

# Install dependencies
npm install

# Start the app in development mode
npm start
```

### Building

```bash
# Create production build
npm run dist
```

The packaged application will be available in the `dist` directory.

## 🎨 Customization

### Overlay Positions

- Top Left/Center/Right
- Middle Left/Center/Right
- Bottom Left/Center/Right

### View Modes

- **Simple**: Shows basic latency information
- **Detailed**: Displays additional connection details

### Appearance

- Adjustable opacity
- Modern frosted glass effect
- Auto-sizing based on content

## 🔒 Permissions

The application requires administrator privileges to:

- Monitor network connections
- Track application-specific network statistics
- Access detailed network information

## 🤝 Contributing

Your contributions make the open-source community an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Inspired by Valorant's network statistics overlay
- Built with [Electron](https://www.electronjs.org/)
- Uses [electron-store](https://github.com/sindresorhus/electron-store) for settings management

---

<div align="center">
  Made with ❤️ by HaitamElb
</div>
