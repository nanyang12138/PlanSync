import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CoreMock = {
  getInput: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
  setOutput: ReturnType<typeof vi.fn>;
  setFailed: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warning: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const coreMock: CoreMock = {
  getInput: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
};

vi.mock('@actions/core', () => coreMock);

type InputMap = Record<string, string>;

function configureInputs(inputs: InputMap) {
  coreMock.getInput.mockImplementation((name: string) => inputs[name] ?? '');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('github-action run()', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.values(coreMock).forEach((fn) => fn.mockReset());
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('masks the api-key via core.setSecret immediately after reading inputs', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_supersecret_value_42',
      project: 'proj-123',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setSecret).toHaveBeenCalledTimes(1);
    expect(coreMock.setSecret).toHaveBeenCalledWith('ps_key_supersecret_value_42');

    // setSecret must be called before any HTTP request (so the masking is
    // active before the value could leak into a downstream log).
    const setSecretOrder = coreMock.setSecret.mock.invocationCallOrder[0];
    const fetchOrder = fetchSpy.mock.invocationCallOrder[0];
    expect(setSecretOrder).toBeLessThan(fetchOrder);
  });

  it('does not call core.setSecret when api-key input is empty', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': '',
      project: 'proj-123',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'unauthorized' } }));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setSecret).not.toHaveBeenCalled();
    expect(coreMock.setFailed).toHaveBeenCalledWith('unauthorized');
  });
});
