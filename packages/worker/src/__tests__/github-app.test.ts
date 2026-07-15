import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAuth = vi.fn();
const mockCreateAppAuth = vi.fn((_options: unknown) => mockAuth);
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: (options: unknown) => mockCreateAppAuth(options),
}));

import { getInstallationToken } from '../github-app.js';

describe('getInstallationToken', () => {
  const saved = {
    appId: process.env['GITHUB_APP_ID'],
    privateKey: process.env['GITHUB_APP_PRIVATE_KEY'],
  };

  beforeEach(() => {
    mockAuth.mockReset();
    mockCreateAppAuth.mockClear();
    process.env['GITHUB_APP_ID'] = '12345';
    process.env['GITHUB_APP_PRIVATE_KEY'] = 'fake-pem';
  });

  afterEach(() => {
    if (saved.appId === undefined) delete process.env['GITHUB_APP_ID'];
    else process.env['GITHUB_APP_ID'] = saved.appId;
    if (saved.privateKey === undefined) delete process.env['GITHUB_APP_PRIVATE_KEY'];
    else process.env['GITHUB_APP_PRIVATE_KEY'] = saved.privateKey;
  });

  it('throws when GITHUB_APP_ID is missing', async () => {
    delete process.env['GITHUB_APP_ID'];
    await expect(getInstallationToken(1)).rejects.toThrow(
      'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY required',
    );
    expect(mockCreateAppAuth).not.toHaveBeenCalled();
  });

  it('throws when GITHUB_APP_PRIVATE_KEY is missing', async () => {
    delete process.env['GITHUB_APP_PRIVATE_KEY'];
    await expect(getInstallationToken(1)).rejects.toThrow(
      'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY required',
    );
    expect(mockCreateAppAuth).not.toHaveBeenCalled();
  });

  it('exchanges app credentials for an installation token', async () => {
    mockAuth.mockResolvedValueOnce({ token: 'ghs_installation_token' });

    const token = await getInstallationToken(987);

    expect(token).toBe('ghs_installation_token');
    expect(mockCreateAppAuth).toHaveBeenCalledWith({ appId: '12345', privateKey: 'fake-pem' });
    expect(mockAuth).toHaveBeenCalledWith({ type: 'installation', installationId: 987 });
  });

  it('propagates auth failures', async () => {
    mockAuth.mockRejectedValueOnce(new Error('installation not found'));
    await expect(getInstallationToken(404)).rejects.toThrow('installation not found');
  });
});
