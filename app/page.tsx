import { PortfolioChat } from "@/components/chat/PortfolioChat";
import {
  getArchitecture,
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

  const architectures = Object.fromEntries(
    featured.map((project) => [project.id, getArchitecture(project.id)]),
  );

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
