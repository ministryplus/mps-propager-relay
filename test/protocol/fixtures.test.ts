import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { ProtocolError, parseClientFrame, parseServerFrame } from '../../src/protocol/parse.js';
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from '../../src/protocol/types.js';

const protocolDir = fileURLToPath(new URL('../../protocol/', import.meta.url));
const read = (rel: string) => readFileSync(protocolDir + rel, 'utf8');
const list = (dir: string) =>
  readdirSync(protocolDir + dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

// Every member of each union, checked both ways at compile time.
const CLIENT_TYPES = ['hello', 'reply', 'react', 'post', 'history', 'ping'] as const;
const SERVER_TYPES = [
  'welcome',
  'message',
  'result',
  'history_result',
  'status',
  'pong',
  'error',
] as const;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const clientExact: Exact<(typeof CLIENT_TYPES)[number], ClientFrame['type']> = true;
const serverExact: Exact<(typeof SERVER_TYPES)[number], ServerFrame['type']> = true;
void clientExact;
void serverExact;

const isClientType = (t: unknown) => (CLIENT_TYPES as readonly unknown[]).includes(t);

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(JSON.parse(read('schema/frame.schema.json')));

const validFiles = list('fixtures/valid');
const invalidFiles = list('fixtures/invalid');

describe('valid fixtures', () => {
  it('exist', () => expect(validFiles.length).toBeGreaterThan(0));

  it.each(validFiles)('%s passes the schema and its direction’s parser only', (file) => {
    const text = read(`fixtures/valid/${file}`);
    const json = JSON.parse(text) as { type: string };

    expect(validate(json), JSON.stringify(validate.errors)).toBe(true);

    const [right, wrong] = isClientType(json.type)
      ? [parseClientFrame, parseServerFrame]
      : [parseServerFrame, parseClientFrame];
    expect(right(text).type).toBe(json.type);
    expect(() => wrong(text)).toThrow(ProtocolError);
  });

  it('cover every frame type', () => {
    const seen = new Set(
      validFiles.map((f) => (JSON.parse(read(`fixtures/valid/${f}`)) as { type: string }).type),
    );
    expect([...seen].sort()).toEqual([...CLIENT_TYPES, ...SERVER_TYPES].sort());
  });
});

describe('invalid fixtures', () => {
  it('exist', () => expect(invalidFiles.length).toBeGreaterThan(0));

  it.each(invalidFiles)('%s fails the schema and both parsers', (file) => {
    const text = read(`fixtures/invalid/${file}`);

    let json: unknown;
    let parsed = true;
    try {
      json = JSON.parse(text);
    } catch {
      parsed = false;
    }
    if (parsed) expect(validate(json)).toBe(false);

    expect(() => parseClientFrame(text)).toThrow(ProtocolError);
    expect(() => parseServerFrame(text)).toThrow(ProtocolError);
  });
});

describe('protocol/VERSION', () => {
  it('matches PROTOCOL_VERSION', () => {
    expect(read('VERSION').trim()).toBe(String(PROTOCOL_VERSION));
  });
});
