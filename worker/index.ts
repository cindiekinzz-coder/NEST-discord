/**
 * NEST-discord Cloudflare Worker
 *
 * Wraps the Discord bot as an HTTP MCP endpoint.
 * Path-based auth: /mcp/:secret
 *
 * Used by NEST-gateway via service binding (no workers.dev loop detection issue).
 * Also accessible directly for mobile clients and KAIROS webhook processing.
 *
 * Deploy with: wrangler deploy
 */

import { McpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export interface Env {
  DISCORD_TOKEN: string          // Bot token from Discord Developer Portal
  MCP_SECRET: string             // Path-based auth secret (used in /mcp/:secret)
  KAIROS_WEBHOOK_SECRET?: string // Optional: verify KAIROS webhook payloads
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
}

// ─── Discord REST helpers ──────────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10'

async function discordGet(path: string, token: string): Promise<any> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Discord API ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.json()
}

async function discordPost(path: string, token: string, body: unknown): Promise<any> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Discord API ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.json()
}

async function discordDelete(path: string, token: string): Promise<void> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bot ${token}` },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Discord API ${res.status}: ${err.slice(0, 200)}`)
  }
}

// ─── MCP Agent ────────────────────────────────────────────────────────────

export class DiscordMcp extends McpAgent<Env> {
  server = new McpServer({ name: 'nest-discord', version: '1.0.0' })

  async init() {
    const token = this.env.DISCORD_TOKEN

    // ── Read ──

    this.server.tool('discord_list_servers', 'List Discord servers the bot is in', {}, async () => {
      const guilds = await discordGet('/users/@me/guilds', token)
      return { content: [{ type: 'text', text: JSON.stringify(guilds.map((g: any) => ({ id: g.id, name: g.name })), null, 2) }] }
    })

    this.server.tool('discord_get_server_info', 'Get channels and info for a Discord server', {
      guildId: z.string().describe('Server/guild ID'),
    }, async ({ guildId }) => {
      const [guild, channels] = await Promise.all([
        discordGet(`/guilds/${guildId}?with_counts=true`, token),
        discordGet(`/guilds/${guildId}/channels`, token),
      ])
      return { content: [{ type: 'text', text: JSON.stringify({ guild, channels }, null, 2) }] }
    })

    this.server.tool('discord_read_messages', 'Read recent messages from a Discord channel', {
      channelId: z.string().describe('Channel ID'),
      limit: z.number().optional().describe('Number of messages (default 50, max 100)'),
    }, async ({ channelId, limit = 50 }) => {
      const messages = await discordGet(`/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`, token)
      const formatted = messages.map((m: any) => ({
        id: m.id,
        content: m.content,
        author: { id: m.author.id, username: m.author.username, bot: m.author.bot },
        timestamp: m.timestamp,
        attachments: m.attachments?.length ?? 0,
        embeds: m.embeds?.length ?? 0,
        replyTo: m.referenced_message?.id ?? null,
      }))
      return { content: [{ type: 'text', text: JSON.stringify({ channelId, messageCount: formatted.length, messages: formatted }, null, 2) }] }
    })

    this.server.tool('discord_search_messages', 'Search for messages in a Discord server', {
      guildId: z.string(),
      content: z.string().optional(),
      authorId: z.string().optional(),
      channelId: z.string().optional(),
      limit: z.number().optional(),
    }, async ({ guildId, content, authorId, channelId, limit = 25 }) => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (content) params.set('content', content)
      if (authorId) params.set('author_id', authorId)
      if (channelId) params.set('channel_id', channelId)
      const result = await discordGet(`/guilds/${guildId}/messages/search?${params}`, token)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    })

    // ── Send ──

    this.server.tool('discord_send', 'Send a message to a Discord channel', {
      channelId: z.string().describe('Channel ID'),
      message: z.string().describe('Message content'),
      replyToMessageId: z.string().optional().describe('Message ID to reply to'),
    }, async ({ channelId, message, replyToMessageId }) => {
      const body: any = { content: message }
      if (replyToMessageId) body.message_reference = { message_id: replyToMessageId }
      const sent = await discordPost(`/channels/${channelId}/messages`, token, body)
      return { content: [{ type: 'text', text: `Message sent. ID: ${sent.id}` }] }
    })

    this.server.tool('discord_delete_message', 'Delete a Discord message', {
      channelId: z.string(),
      messageId: z.string(),
    }, async ({ channelId, messageId }) => {
      await discordDelete(`/channels/${channelId}/messages/${messageId}`, token)
      return { content: [{ type: 'text', text: `Deleted message ${messageId}` }] }
    })

    // ── Reactions ──

    this.server.tool('discord_add_reaction', 'Add a reaction to a message', {
      channelId: z.string(),
      messageId: z.string(),
      emoji: z.string().describe('Emoji character or name:id for custom emoji'),
    }, async ({ channelId, messageId, emoji }) => {
      const encoded = encodeURIComponent(emoji)
      const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${token}` },
      })
      if (!res.ok) throw new Error(`Discord API ${res.status}`)
      return { content: [{ type: 'text', text: `Added reaction ${emoji} to message ${messageId}` }] }
    })

    this.server.tool('discord_add_multiple_reactions', 'Add multiple reactions to a message', {
      channelId: z.string(),
      messageId: z.string(),
      emojis: z.array(z.string()),
    }, async ({ channelId, messageId, emojis }) => {
      for (const emoji of emojis) {
        const encoded = encodeURIComponent(emoji)
        await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, {
          method: 'PUT',
          headers: { Authorization: `Bot ${token}` },
        })
        await new Promise(r => setTimeout(r, 300)) // rate limit
      }
      return { content: [{ type: 'text', text: `Added ${emojis.length} reactions to message ${messageId}` }] }
    })

    this.server.tool('discord_remove_reaction', 'Remove a reaction from a message', {
      channelId: z.string(),
      messageId: z.string(),
      emoji: z.string(),
      userId: z.string().optional().describe('User ID — omit to remove bot reaction'),
    }, async ({ channelId, messageId, emoji, userId }) => {
      const encoded = encodeURIComponent(emoji)
      const target = userId ? userId : '@me'
      await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encoded}/${target}`, {
        method: 'DELETE',
        headers: { Authorization: `Bot ${token}` },
      })
      return { content: [{ type: 'text', text: `Removed reaction ${emoji} from message ${messageId}` }] }
    })

    // ── Fetch image ──

    this.server.tool('discord_fetch_image', 'Fetch image attachment URL from a Discord message', {
      channelId: z.string(),
      messageId: z.string(),
    }, async ({ channelId, messageId }) => {
      const msg = await discordGet(`/channels/${channelId}/messages/${messageId}`, token)
      const images = [
        ...(msg.attachments || []).filter((a: any) => a.content_type?.startsWith('image/')).map((a: any) => a.url),
        ...(msg.embeds || []).filter((e: any) => e.image).map((e: any) => e.image.url),
      ]
      if (images.length === 0) return { content: [{ type: 'text', text: 'No images found in this message.' }] }
      return { content: [{ type: 'text', text: images.join('\n') }] }
    })

    // ── Channels ──

    this.server.tool('discord_create_text_channel', 'Create a text channel in a Discord server', {
      guildId: z.string(),
      channelName: z.string(),
      topic: z.string().optional(),
      reason: z.string().optional(),
    }, async ({ guildId, channelName, topic, reason }) => {
      const body: any = { name: channelName, type: 0 } // 0 = GUILD_TEXT
      if (topic) body.topic = topic
      const ch = await discordPost(`/guilds/${guildId}/channels`, token, body)
      return { content: [{ type: 'text', text: `Created channel "${channelName}" (ID: ${ch.id})` }] }
    })

    this.server.tool('discord_delete_channel', 'Delete a Discord channel', {
      channelId: z.string(),
      reason: z.string().optional(),
    }, async ({ channelId }) => {
      await discordDelete(`/channels/${channelId}`, token)
      return { content: [{ type: 'text', text: `Deleted channel ${channelId}` }] }
    })

    // ── Categories ──

    this.server.tool('discord_create_category', 'Create a category in a Discord server', {
      guildId: z.string(),
      name: z.string(),
      position: z.number().optional(),
    }, async ({ guildId, name, position }) => {
      const body: any = { name, type: 4 } // 4 = GUILD_CATEGORY
      if (position !== undefined) body.position = position
      const cat = await discordPost(`/guilds/${guildId}/channels`, token, body)
      return { content: [{ type: 'text', text: `Created category "${name}" (ID: ${cat.id})` }] }
    })

    this.server.tool('discord_edit_category', 'Edit a Discord category name or position', {
      categoryId: z.string(),
      name: z.string().optional(),
      position: z.number().optional(),
    }, async ({ categoryId, name, position }) => {
      const body: any = {}
      if (name) body.name = name
      if (position !== undefined) body.position = position
      const res = await fetch(`${DISCORD_API}/channels/${categoryId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Discord API ${res.status}`)
      return { content: [{ type: 'text', text: `Edited category ${categoryId}` }] }
    })

    this.server.tool('discord_delete_category', 'Delete a Discord category', {
      categoryId: z.string(),
    }, async ({ categoryId }) => {
      await discordDelete(`/channels/${categoryId}`, token)
      return { content: [{ type: 'text', text: `Deleted category ${categoryId}` }] }
    })

    // ── Forums ──

    this.server.tool('discord_get_forum_channels', 'List forum channels in a Discord server', {
      guildId: z.string(),
    }, async ({ guildId }) => {
      const channels = await discordGet(`/guilds/${guildId}/channels`, token)
      const forums = channels.filter((c: any) => c.type === 15) // 15 = GUILD_FORUM
      return { content: [{ type: 'text', text: JSON.stringify(forums.map((f: any) => ({ id: f.id, name: f.name, topic: f.topic })), null, 2) }] }
    })

    this.server.tool('discord_create_forum_post', 'Create a post in a Discord forum channel', {
      forumChannelId: z.string(),
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()).optional().describe('Tag names to apply'),
    }, async ({ forumChannelId, title, content, tags }) => {
      // Get available tags first if needed
      let appliedTags: string[] = []
      if (tags && tags.length > 0) {
        const channel = await discordGet(`/channels/${forumChannelId}`, token)
        appliedTags = (channel.available_tags || [])
          .filter((t: any) => tags.includes(t.name))
          .map((t: any) => t.id)
      }
      const body: any = { name: title, message: { content } }
      if (appliedTags.length > 0) body.applied_tags = appliedTags
      const thread = await discordPost(`/channels/${forumChannelId}/threads`, token, body)
      return { content: [{ type: 'text', text: `Created forum post "${title}" (ID: ${thread.id})` }] }
    })

    this.server.tool('discord_get_forum_post', 'Get a forum post and its messages', {
      threadId: z.string(),
    }, async ({ threadId }) => {
      const [thread, messages] = await Promise.all([
        discordGet(`/channels/${threadId}`, token),
        discordGet(`/channels/${threadId}/messages?limit=10`, token),
      ])
      return { content: [{ type: 'text', text: JSON.stringify({ thread, messages }, null, 2) }] }
    })

    this.server.tool('discord_reply_to_forum', 'Reply to a forum post', {
      threadId: z.string(),
      message: z.string(),
    }, async ({ threadId, message }) => {
      const sent = await discordPost(`/channels/${threadId}/messages`, token, { content: message })
      return { content: [{ type: 'text', text: `Replied to forum post ${threadId}. Message ID: ${sent.id}` }] }
    })

    this.server.tool('discord_delete_forum_post', 'Delete a forum post/thread', {
      threadId: z.string(),
    }, async ({ threadId }) => {
      await discordDelete(`/channels/${threadId}`, token)
      return { content: [{ type: 'text', text: `Deleted forum post ${threadId}` }] }
    })

    // ── Webhooks ──

    this.server.tool('discord_create_webhook', 'Create a webhook for a channel', {
      channelId: z.string(),
      name: z.string(),
      reason: z.string().optional(),
    }, async ({ channelId, name }) => {
      const wh = await discordPost(`/channels/${channelId}/webhooks`, token, { name })
      return { content: [{ type: 'text', text: `Created webhook "${name}" (ID: ${wh.id}, token: ${wh.token})` }] }
    })

    this.server.tool('discord_send_webhook_message', 'Send a message via webhook', {
      webhookId: z.string(),
      webhookToken: z.string(),
      content: z.string(),
      username: z.string().optional(),
      avatarURL: z.string().optional(),
      threadId: z.string().optional(),
    }, async ({ webhookId, webhookToken, content, username, avatarURL, threadId }) => {
      const url = new URL(`${DISCORD_API}/webhooks/${webhookId}/${webhookToken}`)
      if (threadId) url.searchParams.set('thread_id', threadId)
      const body: any = { content }
      if (username) body.username = username
      if (avatarURL) body.avatar_url = avatarURL
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Discord API ${res.status}`)
      return { content: [{ type: 'text', text: `Sent webhook message to ${webhookId}` }] }
    })

    this.server.tool('discord_edit_webhook', 'Edit a webhook', {
      webhookId: z.string(),
      webhookToken: z.string().optional(),
      name: z.string().optional(),
      channelId: z.string().optional(),
    }, async ({ webhookId, webhookToken, name, channelId }) => {
      const body: any = {}
      if (name) body.name = name
      if (channelId) body.channel_id = channelId
      const path = webhookToken
        ? `/webhooks/${webhookId}/${webhookToken}`
        : `/webhooks/${webhookId}`
      const res = await fetch(`${DISCORD_API}${path}`, {
        method: 'PATCH',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Discord API ${res.status}`)
      return { content: [{ type: 'text', text: `Edited webhook ${webhookId}` }] }
    })

    this.server.tool('discord_delete_webhook', 'Delete a webhook', {
      webhookId: z.string(),
      webhookToken: z.string().optional(),
    }, async ({ webhookId, webhookToken }) => {
      const path = webhookToken
        ? `/webhooks/${webhookId}/${webhookToken}`
        : `/webhooks/${webhookId}`
      await discordDelete(path, token)
      return { content: [{ type: 'text', text: `Deleted webhook ${webhookId}` }] }
    })

    // ── Voice ──

    this.server.tool('discord_send_voice', 'Note: Voice not supported in Worker mode — use local MCP for voice features', {
      channelId: z.string(),
    }, async () => {
      return { content: [{ type: 'text', text: 'Voice features require the local Node.js MCP. The Worker version supports text channels only.' }] }
    })
  }
}

// ─── HTTP routing ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'nest-discord' }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      })
    }

    // Path-based auth: /mcp/:secret
    // Allows service binding calls without Authorization header
    const pathMatch = url.pathname.match(/^\/mcp\/(.+)$/)
    if (pathMatch) {
      const secret = pathMatch[1]
      if (secret !== env.MCP_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...CORS }
        })
      }
      // Rewrite path to /mcp for McpAgent
      const rewritten = new Request(new URL('/mcp', request.url).toString(), request)
      return DiscordMcp.serve('/mcp').fetch(rewritten, env, ctx)
    }

    // Standard MCP endpoint (Bearer token auth)
    if (url.pathname === '/mcp') {
      const auth = request.headers.get('Authorization')
      if (env.MCP_SECRET && auth !== `Bearer ${env.MCP_SECRET}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...CORS }
        })
      }
      return DiscordMcp.serve('/mcp').fetch(request, env, ctx)
    }

    return new Response('NEST-discord Worker — MCP at /mcp/:secret', {
      headers: { 'Content-Type': 'text/plain', ...CORS }
    })
  }
}
