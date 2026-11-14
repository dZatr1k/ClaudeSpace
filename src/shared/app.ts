// App identity shared by main and the packaging config.

/** electron-builder appId (electron-builder.yml) = Windows AppUserModelID of the installed app (Start-menu shortcut).
 * Toasts of the packaged app only show when the process uses the same ID; tests/unit/updater.node.test.ts checks it. */
export const APP_ID = 'io.github.claudespace';
