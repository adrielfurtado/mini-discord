const { app, BrowserWindow, session, desktopCapturer, Menu } = require('electron');

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Intercepta o pedido de compartilhar tela e cria um menu para escolher
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      
      // Cria um menu nativo do Windows com as opções (Telas e Janelas abertas)
      const template = sources.map(source => ({
        label: source.name,
        click: () => {
          // Quando o usuário clica na janela, envia o vídeo e o áudio do sistema
          callback({ video: source, audio: 'loopback' });
        }
      }));
      
      const menu = Menu.buildFromTemplate(template);
      
      // Exibe o menu na tela perto do rato
      menu.popup();
    });
  });

  // Carrega o seu servidor hospedado no Render
  win.loadURL('https://mini-discord-iwuv.onrender.com');
});

// Fecha o aplicativo completamente ao clicar no X
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});