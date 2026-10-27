import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AccountIdentity } from './accounts.js';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** Minimal standards-based OIDC client for SmartCrawl's server-side web login. */
export class OidcClient {
  private discovery?: DiscoveryDocument;
  private keySet?: ReturnType<typeof createRemoteJWKSet>;

  constructor(readonly config: OidcConfig) {}

  static fromEnv(env = process.env): OidcClient | undefined {
    const issuer = env.SMARTCRAWL_OIDC_ISSUER?.trim();
    const clientId = env.SMARTCRAWL_OIDC_CLIENT_ID?.trim();
    const redirectUri = env.SMARTCRAWL_OIDC_REDIRECT_URI?.trim();
    if (!issuer || !clientId || !redirectUri) return undefined;
    return new OidcClient({
      issuer: normalizeIssuer(issuer),
      clientId,
      clientSecret: env.SMARTCRAWL_OIDC_CLIENT_SECRET?.trim() || undefined,
      redirectUri,
    });
  }

  async authorizationUrl(input: { state: string; nonce: string; codeVerifier: string }): Promise<string> {
    const discovery = await this.getDiscovery();
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'openid profile email',
      state: input.state,
      nonce: input.nonce,
      code_challenge: sha256Base64Url(input.codeVerifier),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string; nonce: string }): Promise<AccountIdentity> {
    const discovery = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: input.codeVerifier,
    });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (this.config.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`;
    }
    const response = await fetch(discovery.token_endpoint, { method: 'POST', headers, body });
    if (!response.ok) throw new Error('Identity provider rejected the sign-in response');
    const token = await response.json() as { id_token?: unknown };
    if (typeof token.id_token !== 'string') throw new Error('Identity provider did not return an ID token');

    const claims = await this.verifyIdToken(token.id_token, discovery);
    if (claims.nonce !== input.nonce) throw new Error('Identity provider returned an invalid login nonce');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('Identity provider did not return a user subject');
    return {
      issuer: normalizeIssuer(discovery.issuer),
      subject: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
    };
  }

  private async getDiscovery(): Promise<DiscoveryDocument> {
    if (this.discovery) return this.discovery;
    const url = new URL('.well-known/openid-configuration', `${this.config.issuer}/`);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Could not load identity provider configuration');
    const value = await response.json() as Partial<DiscoveryDocument>;
    if (!value.issuer || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) {
      throw new Error('Identity provider configuration is incomplete');
    }
    const issuer = normalizeIssuer(value.issuer);
    if (issuer !== this.config.issuer) throw new Error('Identity provider issuer does not match configuration');
    this.discovery = {
      issuer,
      authorization_endpoint: value.authorization_endpoint,
      token_endpoint: value.token_endpoint,
      jwks_uri: value.jwks_uri,
    };
    this.keySet = createRemoteJWKSet(new URL(value.jwks_uri));
    return this.discovery;
  }

  private async verifyIdToken(idToken: string, discovery: DiscoveryDocument): Promise<JWTPayload> {
    if (!this.keySet) this.keySet = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload } = await jwtVerify(idToken, this.keySet, {
      issuer: discovery.issuer,
      audience: this.config.clientId,
    });
    return payload;
  }
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/$/, '');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
