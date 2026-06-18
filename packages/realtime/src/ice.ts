export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnCreds {
  host: string;
  username: string;
  credential: string;
}

const PUBLIC_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/**
 * Public STUN is always present (LAN + easy-NAT work with zero infra).
 * Self-hosted STUN + TURN (+ TURNS/443, the hostile-network lifeline) are
 * appended only when the relay minted time-limited creds.
 */
export function buildIceServers(turn?: TurnCreds): IceServer[] {
  const servers: IceServer[] = [{ urls: [...PUBLIC_STUN] }];
  if (turn) {
    servers.push({ urls: `stun:${turn.host}:3478` });
    servers.push({
      urls: [`turn:${turn.host}:3478?transport=udp`, `turns:${turn.host}:443?transport=tcp`],
      username: turn.username,
      credential: turn.credential,
    });
  }
  return servers;
}
