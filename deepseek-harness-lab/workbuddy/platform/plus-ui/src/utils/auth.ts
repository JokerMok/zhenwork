localStorage.removeItem('Admin-Token');
// This is a UI hint only. The server authenticates the HttpOnly Sa-Token cookie.
const tokenStorage = useStorage<null | string>('Workspace-Login-Hint', null);
export const getToken = () => tokenStorage.value;
export const setToken = (_accessToken: string) => (tokenStorage.value = 'cookie-session');
export const removeToken = () => (tokenStorage.value = null);
