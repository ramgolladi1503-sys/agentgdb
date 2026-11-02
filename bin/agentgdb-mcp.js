#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createManagedMcpServer } from '../src/managed_mcp_server.js';

const server = createManagedMcpServer();
await server.connect(new StdioServerTransport());
