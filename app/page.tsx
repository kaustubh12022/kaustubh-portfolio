import { PortfolioChat } from "@/components/chat/PortfolioChat";
import {
  getArchitectures,
  getClaims,
  getFeaturedProjects,
  getProfile,
  getProjects,
} from "@/lib/content/load";

export default function HomePage() {
  const profile = getProfile();
  const projects = getProjects();
  const featured = getFeaturedProjects();
  const claims = getClaims();

  // EVERY captured architecture, not only the featured ones.
  //
  // The assistant answers questions about any project in the content layer.
  // Loading the diagrams only for the featured three meant that asking
  // about DayScore - which HAS a captured diagram - showed "not captured
  // yet", which is false. A false "not captured" is worse than no answer.
  const architectures = getArchitectures();

  return (
    <PortfolioChat
      profile={profile}
      projects={projects}
      featured={featured}
      claims={claims}
      architectures={architectures}
    />
  );
}
