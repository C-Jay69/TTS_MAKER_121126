import { Studio } from "@/components/studio/studio";
import { StudioErrorBoundary } from "@/components/studio/error-boundary";

export default function Home() {
  return (
    <StudioErrorBoundary>
      <Studio />
    </StudioErrorBoundary>
  );
}
