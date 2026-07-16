import type { PullRequestInput } from "./analyzer";

export const demoPullRequests: PullRequestInput[] = [
  {
    number: 101,
    title: "Require locale when formatting a user name",
    ciPassed: true,
    mergeable: true,
    files: ["src/user/format.ts"],
    diff: `diff --git a/src/user/format.ts b/src/user/format.ts
--- a/src/user/format.ts
+++ b/src/user/format.ts
-export function formatUser(name: string) {
+export function formatUser(name: string, locale: string) {
   return name.trim()
 }`,
  },
  {
    number: 102,
    title: "Add profile greeting",
    ciPassed: true,
    mergeable: true,
    files: ["src/profile/greeting.ts"],
    diff: `diff --git a/src/profile/greeting.ts b/src/profile/greeting.ts
--- a/src/profile/greeting.ts
+++ b/src/profile/greeting.ts
+import { formatUser } from "../user/format"
+export const greeting = (name: string) => \`Hello, \${formatUser(name)}\``,
  },
  {
    number: 103,
    title: "Cache health endpoint response",
    ciPassed: true,
    mergeable: true,
    files: ["src/health/cache.ts"],
    diff: `diff --git a/src/health/cache.ts b/src/health/cache.ts
--- a/src/health/cache.ts
+++ b/src/health/cache.ts
+export const healthTtl = () => cache.get("health-ttl")`,
  },
];
