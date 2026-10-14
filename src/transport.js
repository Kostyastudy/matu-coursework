const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const iconv = require('iconv-lite');
const { CookieJar } = require('tough-cookie');
const { TransportError, MatuError } = require('./errors');

class Transport {
  constructor(baseUrl, options = {}) {
    this.baseUrl = new URL(baseUrl);
    this.timeout = options.timeout || 15000;
    this.maxBytes = options.maxBytes || 8 * 1024 * 1024;
    this.jar = new CookieJar();
    this.requests = new Set();
  }

  clear() { this.jar = new CookieJar(); }
  dispose() {
    for (const request of this.requests) request.destroy();
    this.requests.clear();
    this.clear();
  }

  async request(target, { method = 'GET', body, headers = {}, redirects = 0, deadline } = {}) {
    const url = new URL(target, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new MatuError('已拒绝访问码图以外的地址。', 'ORIGIN');
    }
    const expires = deadline || Date.now() + this.timeout;
    if (redirects > 5 || Date.now() >= expires) throw new TransportError('网站请求超时。', method === 'POST');
    const cookie = this.jar.getCookieStringSync(url.href);
    const buffer = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method,
        headers: {
          'User-Agent': 'MatuCourseworkVSCode/0.1.0',
          Accept: 'text/html,*/*',
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
          ...(buffer ? { 'Content-Length': buffer.length } : {})
        }
      }, result => {
        const chunks = [];
        let size = 0;
        result.on('data', chunk => {
          size += chunk.length;
          if (size > this.maxBytes) {
            request.destroy();
            reject(new TransportError('网站返回内容过大，已停止读取。', method === 'POST'));
          } else chunks.push(chunk);
        });
        result.on('end', () => resolve({
          status: result.statusCode, headers: result.headers, bytes: Buffer.concat(chunks), url: url.href
        }));
        result.on('error', () => reject(new TransportError('网站连接中断。', method === 'POST')));
      });
      this.requests.add(request);
      const timer = setTimeout(() => request.destroy(new Error('timeout')), Math.max(1, expires - Date.now()));
      request.on('close', () => { clearTimeout(timer); this.requests.delete(request); });
      request.on('error', error => {
        reject(new TransportError(error.message === 'timeout' ? '网站请求超时。' : '无法连接码图网站，请检查网络后重试。', method === 'POST'));
      });
      if (buffer) request.write(buffer);
      request.end();
    });
    for (const value of response.headers['set-cookie'] || []) this.jar.setCookieSync(value, url.href, { ignoreError: true });
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      if (method === 'POST' && [307, 308].includes(response.status)) {
        throw new TransportError('网站要求重新发送上传请求，已停止以避免重复提交。', true);
      }
      const next = new URL(location, url);
      if (next.origin !== this.baseUrl.origin) throw new TransportError('网站跳转到了其他地址，已停止访问。', method === 'POST');
      try {
        return await this.request(next.href, {
          method: [301, 302, 303].includes(response.status) ? 'GET' : method,
          redirects: redirects + 1, deadline: expires
        });
      } catch (error) {
        if (method === 'POST' && error instanceof TransportError) error.ambiguous = true;
        throw error;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TransportError(`码图网站返回 HTTP ${response.status}。`, method === 'POST');
    }
    const type = response.headers['content-type'] || '';
    const charset = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(type)?.[1] ||
      /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(response.bytes.subarray(0, 2048).toString('ascii'))?.[1] || 'utf-8';
    response.html = iconv.decode(response.bytes, iconv.encodingExists(charset) ? charset : 'utf-8');
    delete response.bytes;
    return response;
  }
}

function multipart(fields, fileField, filename, source) {
  const boundary = `----Matu${crypto.randomBytes(18).toString('hex')}`;
  const chunks = [];
  const headerSafe = value => {
    if (/[\r\n"]/u.test(value)) throw new MatuError('上传文件名或字段不合法。', 'UPLOAD_FORM');
    return value;
  };
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${headerSafe(name)}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${headerSafe(fileField)}"; filename="${headerSafe(filename)}"\r\nContent-Type: text/plain\r\n\r\n`));
  chunks.push(source);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

module.exports = { Transport, multipart };
