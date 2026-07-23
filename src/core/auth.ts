// Bailey Auth Manager — session-based authentication for the dashboard

import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';

interface Session {
  expires: number;
}

export class AuthManager {
  private sessions = new Map<string, Session>();
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    setInterval(() => this.cleanSessions(), 30 * 60 * 1000);
  }

  private readConfig(): any {
    return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
  }

  isSetupRequired(): boolean {
    try {
      const cfg = this.readConfig();
      return !cfg.security?.admin_password;
    } catch {
      return true;
    }
  }

  login(password: string): string | null {
    try {
      const cfg = this.readConfig();
      const stored = cfg.security?.admin_password;
      if (!stored || password !== stored) return null;
      const token = crypto.randomBytes(32).toString('hex');
      this.sessions.set(token, { expires: Date.now() + 8 * 60 * 60 * 1000 });
      return token;
    } catch {
      return null;
    }
  }

  isAuthenticated(req: http.IncomingMessage): boolean {
    const token = this.extractToken(req);
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expires) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(req: http.IncomingMessage): void {
    const token = this.extractToken(req);
    if (token) this.sessions.delete(token);
  }

  makeCookie(token: string): string {
    return `bailey_session=${token}; HttpOnly; Path=/; Max-Age=${8 * 3600}; SameSite=Strict`;
  }

  clearCookie(): string {
    return 'bailey_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict';
  }

  isPublicPath(pathname: string): boolean {
    // Health endpoint stays public for watchdog.ps1
    if (pathname === '/api/health') return true;
    // Login and auth API
    if (pathname === '/login' || pathname.startsWith('/api/auth/')) return true;
    // Setup wizard (unauthenticated during initial setup)
    if (pathname === '/setup' || pathname.startsWith('/api/setup/')) return true;
    // Bailey icon/logo so login page can load branding
    if (pathname === '/assets/bailey.png' || pathname === '/assets/bailey.ico') return true;
    return false;
  }

  private extractToken(req: http.IncomingMessage): string | null {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/bailey_session=([a-f0-9]{64})/);
    return match ? match[1] : null;
  }

  private cleanSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now > session.expires) this.sessions.delete(token);
    }
  }
}
