export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: any) {
    super(message);
    this.name = "ApiError";
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `HTTP ${res.status}`, data);
  }
  return res.json();
}

export const api = {
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const search = params ? `?${new URLSearchParams(params).toString()}` : "";
    const res = await fetch(`/api/proxy${path}${search}`);
    return handleResponse<T>(res);
  },

  async post<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`/api/proxy${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return handleResponse<T>(res);
  },

  async getBlob(path: string): Promise<Blob> {
    const res = await fetch(`/api/proxy${path}`);
    if (!res.ok) throw new Error(`Failed to fetch blob: ${res.status}`);
    return res.blob();
  }
};
