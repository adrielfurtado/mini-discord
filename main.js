const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#313338', // Cor de fundo estilo Discord Dark Mode
    autoHideMenuBar: true,     // Oculta a barra de menus superior para ficar limpo
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Carrega o teu link oficial do Render
  win.loadURL('https://mini-discord-imuv.onrender.com');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});