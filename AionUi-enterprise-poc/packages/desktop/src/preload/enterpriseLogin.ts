import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('enterpriseLogin', {
  submit: (credentials: {
    username: string;
    password: string;
    serverUrl: string;
    origin?: string;
    rememberPassword: boolean;
    useSavedPassword: boolean;
  }) => ipcRenderer.invoke('enterprise:login', credentials),
  savedAccounts: (serverUrl: string) => ipcRenderer.invoke('enterprise:saved-accounts', serverUrl),
  branding: (serverUrl: string) => ipcRenderer.invoke('enterprise:branding', serverUrl),
  forgetAccount: (serverUrl: string, username: string) =>
    ipcRenderer.invoke('enterprise:forget-account', serverUrl, username),
});
