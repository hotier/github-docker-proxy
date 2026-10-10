// Docker registry-mirrors 入口:Docker daemon 直接请求 /v2/...,不经 /api 前缀
import type { APIRoute } from 'astro';
import { handleDockerProxy } from '../../lib/proxy';
import { checkRateLimit } from '../../lib/rate-limit';
import { withLogging } from '../../lib/logging';

const DOCKER_HUB = 'https://registry-1.docker.io';
const DOCKER_AUTH = 'https://auth.docker.io';

export const ALL: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname;

  const rateLimitError = checkRateLimit(request);
  if (rateLimitError) return rateLimitError;

  return withLogging(request, () =>
    handleDockerProxy(request, path, url.search, DOCKER_HUB, DOCKER_AUTH)
  );
};
