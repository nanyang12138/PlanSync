import { McpConfig } from './config';
import { logger } from './logger';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  constructor(private config: McpConfig) {}

  /** Return a new ApiClient that sends a different X-User-Name header (for delegation).
   *  If a delegationSecret is configured, it is used as the Bearer token so the API
   *  can authenticate any registered user without their individual password. */
  withUser(userName: string): ApiClient {
    return new ApiClient({
      ...this.config,
      userName,
      apiToken: this.config.delegationSecret || this.config.apiToken,
    });
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiToken}`,
      'X-User-Name': this.config.userName,
    };
  }

  private url(path: string): string {
    return `${this.config.apiBaseUrl}${path}`;
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(this.url(path), { headers: this.headers });
    return this.handleResponse<T>(res, 'GET', path);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(res, 'POST', path);
  }

  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(res, 'PATCH', path);
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'DELETE',
      headers: this.headers,
    });
    return this.handleResponse<T>(res, 'DELETE', path);
  }

  private async handleResponse<T>(res: Response, method: string, path: string): Promise<T> {
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      if (!res.ok) throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`);
      // 2xx but unparseable body — surface the error instead of silently returning empty object
      throw new Error(`API returned non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const errMsg = json?.error?.message || `API error ${res.status}`;
      const errCode = json?.error?.code || 'UNKNOWN';
      const errDetails = json?.error?.details;
      logger.error({ method, path, status: res.status, error: json?.error }, 'API request failed');
      throw new ApiError(errMsg, errCode, res.status, errDetails);
    }

    return json as T;
  }
}
