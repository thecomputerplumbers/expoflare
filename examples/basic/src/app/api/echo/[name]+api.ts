export async function POST(request: Request, { name }: { name: string }) {
  return Response.json({ name, body: await request.text() })
}
