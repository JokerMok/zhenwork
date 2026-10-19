export class EnterpriseMcpProxy {
  constructor(options: {
    client: { relayMcp(connectionId: string, raw: string, headers: Record<string, unknown>, signal: AbortSignal,
      conversationId?: string): Promise<Response> };
    connectionId: string;
    onRevoked?: () => void;
    requireConversationId?: boolean;
  });
  start(listenHost?: string): Promise<{ port: number; key: string }>;
  stop(): Promise<void>;
}
