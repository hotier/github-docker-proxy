// 静态文件服务工具

export async function serveStatic(
  path: string,
  contentType: string
): Promise<Response> {
  try {
    const data = await Deno.readFile(path);
    return new Response(data, {
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error(`Failed to serve ${path}:`, error);
    return new Response("Not Found", { status: 404 });
  }
}
