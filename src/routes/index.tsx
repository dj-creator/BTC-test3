import { createFileRoute } from "@tanstack/react-router";
import { Terminal } from "@/components/btc/terminal";
import { getSnapshot } from "@/lib/btc/snapshot";

export const Route = createFileRoute("/")({
  loader: () => getSnapshot(),
  component: Home,
});

function Home() {
  const initial = Route.useLoaderData();
  return <Terminal initial={initial} />;
}
