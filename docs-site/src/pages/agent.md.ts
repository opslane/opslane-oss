import type { APIRoute } from 'astro';

import { agentQuickstartResponse, loadAgentQuickstart } from '../agent-md';

export const GET: APIRoute = () => agentQuickstartResponse(loadAgentQuickstart());
