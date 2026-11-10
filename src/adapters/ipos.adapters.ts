import { Logger } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import type { AdapterResult, CanonicalIpoEvent, IposAdapter } from "./types";
import { withFallback } from "./with-fallback.util";

export class PolygonIposAdapter implements IposAdapter {
  readonly sourceName = "polygon";
  constructor(private readonly polygon: PolygonService) {}

  async fetchIpos(
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalIpoEvent[]>> {
    return {
      data: await this.polygon.getIpoCalendar(from, to),
      source: this.sourceName,
      warnings: [],
    };
  }
}

export class CompositeIposAdapter implements IposAdapter {
  private readonly logger = new Logger(CompositeIposAdapter.name);
  readonly sourceName: string;

  constructor(
    private readonly primary: IposAdapter,
    private readonly secondary: IposAdapter | null,
  ) {
    this.sourceName = secondary
      ? `${primary.sourceName}(fallback:${secondary.sourceName})`
      : primary.sourceName;
  }

  fetchIpos(from: string, to: string) {
    return withFallback(
      "IPOs",
      this.logger,
      this.primary,
      this.secondary,
      (a) => a.fetchIpos(from, to),
    );
  }
}
