import {
  createChannelPluginBase,
  createChatChannelPlugin
} from "openclaw/plugin-sdk/core";
import {
  EMPEROR_CHANNEL_ID,
  inspectEmperorChannelAccount,
  resolveEmperorChannelAccount
} from "./config.js";
import { sendEmperorOutboundText } from "./outbound.js";
import { resolveSessionConversation } from "./session-conversation.js";

export { EMPEROR_CHANNEL_ID, EMPEROR_CHANNEL_LABEL } from "./config.js";

export const emperorChannelPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: EMPEROR_CHANNEL_ID,
    setup: {
      resolveAccount: resolveEmperorChannelAccount,
      inspectAccount: inspectEmperorChannelAccount
    }
  }),
  messaging: {
    resolveSessionConversation
  },
  security: {
    dm: {
      channelKey: EMPEROR_CHANNEL_ID,
      resolvePolicy: (account: any) => account.dmPolicy,
      resolveAllowFrom: (account: any) => account.allowFrom,
      defaultPolicy: "allowlist"
    }
  },
  threading: {
    topLevelReplyToMode: "reply"
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      resolveTarget: ({ to }: { to?: string }) => {
        const trimmed = String(to || "").trim();
        if (!trimmed) {
          return {
            ok: false as const,
            error: new Error("Delivering to Emperor requires a session target")
          };
        }
        return {
          ok: true as const,
          to: trimmed
        };
      }
    },
    attachedResults: {
      channel: EMPEROR_CHANNEL_ID,
      sendText: async (params: any) => {
        const result = await sendEmperorOutboundText({
          account: params.account,
          to: params.to,
          text: params.text,
          threadId: params.threadId || null,
          threadType: params.threadType || null,
          targetAgentId: params.targetAgentId || null
        });
        return {
          messageId: result.messageId || result.threadId || null
        };
      }
    }
  }
});
