import { createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { EMPEROR_CHANNEL_ID, inspectEmperorChannelAccount, listEmperorChannelAccountIds, resolveEmperorChannelAccount } from "./config.js";
import { sendEmperorOutboundText } from "./outbound.js";
import { resolveSessionConversation } from "./session-conversation.js";
export { EMPEROR_CHANNEL_ID, EMPEROR_CHANNEL_LABEL } from "./config.js";
export const emperorChannelPlugin = createChatChannelPlugin({
    base: createChannelPluginBase({
        id: EMPEROR_CHANNEL_ID,
        meta: {
            label: "Emperor",
            selectionLabel: "Emperor",
            docsPath: "https://emperorclaw.malecu.eu/docs",
            blurb: "Connect OpenClaw to Emperor thread messaging."
        },
        setup: {
            resolveAccount: resolveEmperorChannelAccount,
            inspectAccount: inspectEmperorChannelAccount
        },
        config: {
            listAccountIds: listEmperorChannelAccountIds,
            resolveAccount: resolveEmperorChannelAccount,
            inspectAccount: inspectEmperorChannelAccount,
            defaultAccountId: () => "default"
        }
    }),
    messaging: {
        resolveSessionConversation
    },
    security: {
        dm: {
            channelKey: EMPEROR_CHANNEL_ID,
            resolvePolicy: (account) => account.dmPolicy,
            resolveAllowFrom: (account) => account.allowFrom,
            defaultPolicy: "allowlist"
        }
    },
    threading: {
        topLevelReplyToMode: "reply"
    },
    outbound: {
        base: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) => {
                const trimmed = String(to || "").trim();
                if (!trimmed) {
                    return {
                        ok: false,
                        error: new Error("Delivering to Emperor requires a session target")
                    };
                }
                return {
                    ok: true,
                    to: trimmed
                };
            }
        },
        attachedResults: {
            channel: EMPEROR_CHANNEL_ID,
            sendText: async (params) => {
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
