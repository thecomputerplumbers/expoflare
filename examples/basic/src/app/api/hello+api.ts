export function GET(request: Request) {
  return Response.json({
    hello: "world",
    path: new URL(request.url).pathname,
  })
}
