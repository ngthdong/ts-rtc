import { jwtVerify, SignJWT } from 'jose';

export interface TokenOptions {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

/**
 * Access tokens: HS256 JWTs carrying the user id (`sub`). No refresh and no revocation in v1:
 * a token is valid until it expires.
 */
export class Tokens {
  private readonly key: Uint8Array;

  constructor(private readonly options: TokenOptions) {
    this.key = new TextEncoder().encode(options.secret);
  }

  sign(userId: string): Promise<string> {
    const { issuer, audience, ttlSeconds } = this.options;
    return new SignJWT()
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(`${String(ttlSeconds)}s`)
      .sign(this.key);
  }

  /** The user id; undefined for any bad token (signature, alg, exp, iss, aud). Never throws. */
  async verify(token: string): Promise<string | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], // pinned: `none` and algorithm confusion are rejected
        issuer: this.options.issuer,
        audience: this.options.audience,
      });
      return payload.sub;
    } catch {
      return undefined;
    }
  }
}
