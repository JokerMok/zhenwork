export class EnterpriseModelProxy {
  constructor(options: {
    client: { relayModel(modelId: string, raw: string, signal: AbortSignal,
      conversationId?: string): Promise<Response> };
    model: { id: string; code: string; name: string };
    onRevoked?: () => void;
    requireConversationId?: boolean;
  });
  start(listenHost?: string): Promise<{ port: number; key: string }>;
  stop(): Promise<void>;
}
