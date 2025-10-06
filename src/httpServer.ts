/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import type {Debugger} from 'debug';

export interface HttpServerOptions {
  host: string;
  port: number;
  path: string;
  allowedOrigins?: string[];
  logger: Debugger;
}

export async function createHttpServer(
  mcpServer: McpServer,
  options: HttpServerOptions,
): Promise<void> {
  const {host, port, path, allowedOrigins, logger} = options;

  // Map to track transports by session ID
  const transports = new Map<string, SSEServerTransport>();

  // Create HTTP server
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // Set CORS headers if allowed origins are configured
      if (allowedOrigins && allowedOrigins.length > 0) {
        const origin = req.headers.origin;
        if (origin && allowedOrigins.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
      }

      // Handle OPTIONS preflight requests
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Parse URL to check path and extract session ID
      const url = new URL(req.url || '', `http://${req.headers.host}`);

      // Only handle requests to the MCP path
      if (url.pathname !== path) {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('Not Found');
        return;
      }

      try {
        if (req.method === 'GET') {
          // Create new SSE transport for this connection
          const transport = new SSEServerTransport(path, res, {
            allowedOrigins,
            allowedHosts: [host, `${host}:${port}`, 'localhost', `localhost:${port}`],
            enableDnsRebindingProtection: allowedOrigins !== undefined && allowedOrigins.length > 0,
          });

          // Store transport by session ID
          transports.set(transport.sessionId, transport);

          // Start the SSE transport (this sends the endpoint event)
          await transport.start();

          // Connect transport to MCP server (async, don't block)
          mcpServer.connect(transport).then(() => {
            logger(`SSE connection established: ${transport.sessionId}`);
          }).catch((error) => {
            logger(`Error connecting transport: ${error}`);
          });

          // Wait for connection to close before cleaning up
          await new Promise<void>((resolve) => {
            res.on('close', () => {
              transports.delete(transport.sessionId);
              transport.close();
              logger(`SSE connection closed: ${transport.sessionId}`);
              resolve();
            });
          });
        } else if (req.method === 'POST') {
          // Parse request body
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          let body: unknown;
          try {
            body = JSON.parse(bodyStr);
          } catch (error) {
            logger(`Failed to parse request body: ${error}`);
            res.writeHead(400, {'Content-Type': 'text/plain'});
            res.end('Invalid JSON');
            return;
          }

          // Get session ID from query parameter (SSE protocol) or header
          const sessionId = url.searchParams.get('sessionId') ||
                           req.headers['x-session-id'] as string | undefined;

          if (!sessionId) {
            res.writeHead(400, {'Content-Type': 'text/plain'});
            res.end('Missing sessionId query parameter or X-Session-ID header');
            return;
          }

          const transport = transports.get(sessionId);
          if (!transport) {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end('Session not found');
            return;
          }

          // Handle the POST message
          await transport.handlePostMessage(req, res, body);
          logger(`POST message handled for session: ${sessionId}`);
        } else {
          res.writeHead(405, {'Content-Type': 'text/plain'});
          res.end('Method Not Allowed');
        }
      } catch (error) {
        logger(`Error handling request: ${error}`);
        if (!res.headersSent) {
          res.writeHead(500, {'Content-Type': 'text/plain'});
          res.end('Internal Server Error');
        }
      }
    },
  );

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      logger(`HTTP server listening on http://${host}:${port}${path}`);
      resolve();
    });

    server.on('error', (error: Error) => {
      logger(`HTTP server error: ${error}`);
      reject(error);
    });
  });

  // Log security warnings
  if (!allowedOrigins || allowedOrigins.length === 0) {
    console.warn(
      'WARNING: No allowed origins configured. For security, use --httpAllowedOrigins to restrict access.',
    );
  }

  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn(
      'WARNING: Binding to non-localhost address. This may expose the server to network attacks. Use 127.0.0.1 for local-only access.',
    );
  }
}
