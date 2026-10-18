import { copyTextToClipboard } from './clipboard';

describe('copyTextToClipboard', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    });
    jest.restoreAllMocks();
  });

  it('uses the clipboard API when it succeeds', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await expect(copyTextToClipboard('hello')).resolves.toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand and reports denial', async () => {
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockRejectedValue(denied) },
    });
    document.execCommand = jest.fn().mockReturnValue(true);
    await expect(copyTextToClipboard('hello')).resolves.toEqual({ ok: true });

    document.execCommand = jest.fn().mockReturnValue(false);
    await expect(copyTextToClipboard('hello')).resolves.toEqual({
      ok: false,
      reason: 'denied',
    });
    delete document.execCommand;
    await expect(copyTextToClipboard('hello')).resolves.toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('reports unavailable when neither path exists', async () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const previousExecCommand = document.execCommand;
    delete document.execCommand;
    await expect(copyTextToClipboard('hello')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
    document.execCommand = previousExecCommand;
  });
});
