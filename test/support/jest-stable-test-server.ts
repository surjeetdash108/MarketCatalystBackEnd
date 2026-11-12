/**
 * Test-only: every in-process Nest test app gets its OWN loopback port for its
 * whole life, bound to 127.0.0.1 exactly, before any request is made.
 *
 * Before this, supertest started the app's server on a random port for each
 * request (listen(0) on all interfaces) and closed it afterwards. Under the
 * parallel Jest run a request could reach a port this worker no longer owned —
 * or a dual-stack listener shadowed by another socket — and be answered by a
 * DIFFERENT test's app: wrong data, a 404, a 200 instead of 403. That was the
 * "flaky under load" e2e failures.
 *
 * Now NestApplication.init() also listens on 127.0.0.1:0 (an exact, exclusive
 * bind), supertest uses that address and never opens or closes a server itself,
 * and the app's close() (afterEach/afterAll) releases the port.
 */
import { NestApplication } from "@nestjs/core";
import supertest from "supertest";

type Listening = { address(): { port: number } | string | null; listen(port: number): unknown };

const nestProto = NestApplication.prototype as unknown as {
  init(): Promise<unknown>;
  listen(port: number, host: string): Promise<unknown>;
  getHttpServer(): Listening;
};
const originalInit = nestProto.init;
nestProto.init = async function init(this: typeof nestProto) {
  const result = await originalInit.call(this);
  if (!this.getHttpServer().address()) await this.listen(0, "127.0.0.1");
  return result;
};

const testProto = (supertest as unknown as { Test: { prototype: { serverAddress(app: Listening, path: string): string } } }).Test.prototype;
testProto.serverAddress = function serverAddress(app, path) {
  // Plain http.Server (not a Nest app): listen once, never closed by supertest.
  if (!app.address()) app.listen(0);
  const addr = app.address() as { port: number };
  return `http://127.0.0.1:${addr.port}${path}`;
};
