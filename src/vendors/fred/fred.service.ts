import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchJson } from "../../common/http.util";

const BASE_URL = "https://api.stlouisfed.org/fred";

export interface FredObservation {
  date: string;
  value: string;
}

@Injectable()
export class FredService {
  private readonly logger = new Logger(FredService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get("FRED_API_KEY", "");
    if (!this.apiKey) {
      this.logger.warn(
        "FRED_API_KEY not set — macro-events job will fail. Get a free key at https://fredaccount.stlouisfed.org/apikeys",
      );
    }
  }

  async getLatestObservations(
    seriesId: string,
    limit = 2,
  ): Promise<FredObservation[]> {
    const res = await fetchJson<{ observations?: FredObservation[] }>(
      `${BASE_URL}/series/observations?series_id=${seriesId}&api_key=${this.apiKey}&file_type=json&sort_order=desc&limit=${limit}`,
    );
    return res.observations ?? [];
  }
}
