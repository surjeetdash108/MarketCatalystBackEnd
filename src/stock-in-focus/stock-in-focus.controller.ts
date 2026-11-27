import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import {
  ARCHIVE_DEFAULT,
  ARCHIVE_MAX,
  StockInFocusService,
  type StockInFocusBody,
} from "./stock-in-focus.service";

/** Stock in Focus archive: every signed-in account, newest day first. */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class StockInFocusController {
  constructor(private readonly sif: StockInFocusService) {}

  /**
   * `?limit=` (default 30, max 400) is the newest N entries; "load older" asks
   * for a bigger N. One entry a day keeps that small, so there is no cursor.
   */
  @Get("stock-in-focus")
  @Header("Cache-Control", "private, max-age=60")
  async list(@Query("limit") limit?: string) {
    const n = Number(limit);
    return { entries: await this.sif.list(Number.isFinite(n) && n > 0 ? n : ARCHIVE_DEFAULT) };
  }
}

/** Admin writes, from the console's Stock in Focus board (AdminGuard). */
@UseGuards(AdminGuard)
@Controller("api/admin")
export class StockInFocusAdminController {
  constructor(private readonly sif: StockInFocusService) {}

  @Get("stock-in-focus")
  async list() {
    return { entries: await this.sif.list(ARCHIVE_MAX) };
  }

  @Post("stock-in-focus")
  async create(@Body() body: StockInFocusBody) {
    return this.sif.create(body ?? {});
  }

  @Patch("stock-in-focus/:day")
  async update(@Param("day") day: string, @Body() body: StockInFocusBody) {
    return this.sif.update(day, body ?? {});
  }

  @Delete("stock-in-focus/:day")
  async remove(@Param("day") day: string) {
    return this.sif.remove(day);
  }
}
