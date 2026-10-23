import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";

export default function NotFound() {
  return <div className="page"><EmptyState title="Page not found" action={<Button asChild><Link to="/">Go home</Link></Button>}>That link doesn't lead anywhere.</EmptyState></div>;
}
