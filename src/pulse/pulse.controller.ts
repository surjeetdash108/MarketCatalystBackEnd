import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { PulseService, type PulseBody } from "./pulse.service";

/** Market Catalyst Pulse on the dashboard: every signed-in account, newest first. */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class PulseController {
  constructor(private readonly pulse: PulseService) {}

  /** `?q=` searches the text and ticker of every post (see PulseService.search). */
  @Get("pulse")
  async list(@Query("q") q?: string) {
    const query = typeof q === "string" ? q.slice(0, 100) : "";
    return { posts: query.trim() ? await this.pulse.search(query) : await this.pulse.list() };
  }
}

/** Admin writes, from the console's Market Catalyst Pulse section (AdminGuard). */
@UseGuards(AdminGuard)
@Controller("api/admin")
export class PulseAdminController {
  constructor(private readonly pulse: PulseService) {}

  @Get("pulse")
  async list() {
    return { posts: await this.pulse.list() };
  }

  @Post("pulse")
  async create(@Body() body: PulseBody) {
    return this.pulse.create(body ?? {});
  }

  @Patch("pulse/:id")
  async update(@Param("id") id: string, @Body() body: PulseBody) {
    return this.pulse.update(id, body ?? {});
  }

  @Delete("pulse/:id")
  async remove(@Param("id") id: string) {
    return this.pulse.remove(id);
  }
}
