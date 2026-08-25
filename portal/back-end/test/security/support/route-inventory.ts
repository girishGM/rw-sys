/**
 * T-012 test support — a route inventory taken from Nest's own DI container, and the mutating-
 * `@Get()` heuristic built on it (T-012 implementation note 4, TC-18).
 *
 * ### Why this check exists
 *
 * `CsrfGuard` exempts GET, HEAD and OPTIONS, because a CSRF token cannot be required on a
 * navigation. That exemption is only safe while the other half of the rule holds: **no GET
 * endpoint may mutate state** (02-SECURITY.md §4). Nothing in the framework enforces that, and
 * the design document says in as many words that it "is checked by review, not by the
 * framework". A review that has to happen on every diff forever is a review that will be
 * skipped once; this is the cheap mechanical version.
 *
 * ### Why a name heuristic, and what it does not catch
 *
 * It matches handler *names* against a list of mutating verbs. It cannot catch
 * `@Get('archive') async doIt()`, and it is not meant to — it catches the mistake people
 * actually make, which is moving or copying a handler and keeping its name. Stated plainly so
 * nobody mistakes a green run here for a proof that no GET mutates anything.
 *
 * The inventory is read from `ModulesContainer` rather than from Express's router stack: the
 * container is a public, stable Nest API, while `app._router` is an Express internal that moved
 * in Express 5.
 */
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { MUTATING_HANDLER_PREFIXES } from '@/common/security/security.constants';

export interface RouteEntry {
  readonly controller: string;
  readonly handler: string;
  /** `GET`, `POST`, … as declared by the method decorator. */
  readonly method: string;
  /** The controller-level path plus the handler path, unnormalised. */
  readonly path: string;
}

/** Every route Nest knows about, taken from the DI container of a *built* application. */
export function collectRoutes(app: INestApplication): RouteEntry[] {
  const modules = app.get(ModulesContainer);
  const routes: RouteEntry[] = [];

  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;

      const basePath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      const prototype = controller.prototype as Record<string, unknown>;

      for (const handler of Object.getOwnPropertyNames(prototype)) {
        if (handler === 'constructor') continue;

        const descriptor = Object.getOwnPropertyDescriptor(prototype, handler);
        if (descriptor === undefined || typeof descriptor.value !== 'function') continue;

        const method = Reflect.getMetadata(METHOD_METADATA, descriptor.value);
        if (method === undefined) continue;

        routes.push({
          controller: controller.name,
          handler,
          method: RequestMethod[method as number] ?? String(method),
          path: `/${basePath}/${String(
            Reflect.getMetadata(PATH_METADATA, descriptor.value) ?? '',
          )}`.replace(/\/+/g, '/'),
        });
      }
    }
  }

  return routes;
}

/** The routes TC-18 must find none of: a `@Get()` whose handler name reads like a mutation. */
export function findMutatingGetHandlers(routes: readonly RouteEntry[]): RouteEntry[] {
  return routes.filter(
    (route) =>
      route.method === 'GET' &&
      MUTATING_HANDLER_PREFIXES.some((prefix) => route.handler.toLowerCase().startsWith(prefix)),
  );
}
