import { createSyncoClient, type SyncoClient } from "@synco/sdk";

const JWT_KEY = "synco_jwt";

export function getStoredJwt(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(JWT_KEY);
}

export function setStoredJwt(jwt: string): void {
  localStorage.setItem(JWT_KEY, jwt);
}

export function clearStoredJwt(): void {
  localStorage.removeItem(JWT_KEY);
}

let _client: SyncoClient | null = null;

export function getBrowserClient(): SyncoClient {
  if (_client) return _client;
  const baseUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000";
  _client = createSyncoClient({
    baseUrl,
    getToken: () => getStoredJwt(),
  });
  return _client;
}
