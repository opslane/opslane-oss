import { createAppAuth } from '@octokit/auth-app';

export async function getInstallationToken(installationId: number): Promise<string> {
  const appId = process.env['GITHUB_APP_ID'];
  const privateKey = process.env['GITHUB_APP_PRIVATE_KEY'];
  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY required');
  }
  const auth = createAppAuth({ appId, privateKey });
  const { token } = await auth({ type: 'installation', installationId });
  return token;
}
