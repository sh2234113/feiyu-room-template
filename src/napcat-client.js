// NapCat / OneBot 11 兼容客户端。
//
// NapCat 和 SnowLuma 都暴露 OneBot 11 的 WS + HTTP，但 SnowLuma 的 SDK
// 带有它自己的连接/事件封装。这个适配器只实现桥接实际用到的 Surface：
//   - WebSocket 事件：message / notice / meta_event / request
//   - HTTP action：send_* / get_* / raw / request / 表情 / 成员 / 引用
//
// 不依赖 @snowluma/sdk；默认使用 Node 22 自带的 WebSocket。
import { EventEmitter } from 'node:events';

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const RECONNECT_MS = 3_000;

export function normalizeOneBotMessage(message) {
  if (message == null) return '';
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message;
  if (typeof message.build === 'function') return message.build();
  if (Array.isArray(message.items)) return message.items;
  return String(message);
}

export class NapCatClient extends EventEmitter {
  constructor({ url, httpUrl, accessToken = '', reconnect = true } = {}) {
    super();
    this.url = String(url || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    this.reconnect = reconnect !== false;
    this.ws = null;
    this._manualClose = false;
    this._reconnectTimer = null;
    this._connectPromise = null;
    this._closed = false;
  }

  _authHeaders() {
    return this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {};
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;
    this._manualClose = false;
    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.url, { headers: this._authHeaders() });
      } catch (error) {
        this._connectPromise = null;
        reject(error);
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        settled = true;
        this._connectPromise = null;
        this.emit('open');
        resolve();
      };
      ws.onmessage = (event) => {
        let data;
        try { data = JSON.parse(String(event.data ?? '')); } catch { return; }
        if (data && typeof data === 'object') this._dispatch(data);
      };
      ws.onerror = (event) => {
        const error = new Error(event?.message || 'NapCat WebSocket error');
        this.emit('error', error);
        if (!settled) {
          settled = true;
          this._connectPromise = null;
          reject(error);
        }
      };
      ws.onclose = (event) => {
        if (this.ws === ws) this.ws = null;
        this._connectPromise = null;
        if (!this._manualClose) {
          this.emit('close', { code: Number(event?.code) || 1006, reason: String(event?.reason || '') });
          this._scheduleReconnect();
        }
      };
    });
    return this._connectPromise;
  }

  _scheduleReconnect() {
    if (!this.reconnect || this._manualClose) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => this.emit('error', error));
    }, RECONNECT_MS);
  }

  close(code = 1000, reason = 'client close') {
    this._manualClose = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    try { this.ws?.close(code, String(reason).slice(0, 120)); } catch { /* ignore */ }
    this.ws = null;
  }

  _dispatch(event) {
    this.emit('event', event);
    if (event.post_type === 'message') {
      if (event.message_type === 'private') this.emit('privateMessage', event);
      else if (event.message_type === 'group') this.emit('groupMessage', event);
      return;
    }
    if (event.post_type === 'notice') {
      this.emit(`notice:${event.notice_type || ''}`, event);
      if (event.notice_type === 'bot_status') this.emit('botStatus', event);
      return;
    }
    if (event.post_type === 'request') this.emit(`request:${event.request_type || ''}`, event);
  }

  onEvent(handler) { this.on('event', handler); }
  onPrivateMessage(handler) { this.on('privateMessage', handler); }
  onGroupMessage(handler) { this.on('groupMessage', handler); }
  onNotice(type, handler) { this.on(`notice:${type}`, handler); }
  onBotStatus(handler) { this.on('botStatus', handler); }

  async request(action, params = {}, { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
    const res = await fetch(`${this.httpUrl}/${String(action).replace(/^\/+/, '')}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this._authHeaders()
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && (body.status === 'ok' || body.retcode === 0)) return body;
    return body;
  }

  async raw(action, params = {}, options = {}) {
    const body = await this.request(action, params, options);
    if (!body || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`${action} 失败：${body?.wording || body?.message || body?.retcode || 'unknown'}`);
    }
    return body.data;
  }

  getLoginInfo(options = {}) { return this.raw('get_login_info', {}, options); }
  getMessage(messageId, options = {}) { return this.raw('get_msg', { message_id: Number(messageId) }, options); }
  getGroupMemberList(groupId, options = {}) { return this.raw('get_group_member_list', { group_id: Number(groupId) }, options); }
  getGroupMemberInfo(groupId, userId, options = {}) { return this.raw('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) }, options); }
  getImage(params, options = {}) { return this.raw('get_image', params, options); }
  fetchFaceEntity(faceId, options = {}) { return this.raw('fetch_face_entity', { face_id: Number(faceId), refresh: false }, options); }

  sendPrivateMessage(userId, message, options = {}) {
    return this.raw('send_private_msg', { user_id: Number(userId), message: normalizeOneBotMessage(message) }, options);
  }
  sendGroupMessage(groupId, message, options = {}) {
    return this.raw('send_group_msg', { group_id: Number(groupId), message: normalizeOneBotMessage(message) }, options);
  }
}
