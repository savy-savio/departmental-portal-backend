import type { RequestHandler } from "express";
import type { ZodTypeAny } from "zod";

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates and replaces req.body / req.query / req.params with the parsed value.
 * ZodErrors are turned into 422 responses by the central error handler.
 * Schemas use .strict() so unexpected fields (e.g. departmentId, role) are rejected.
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      next(err);
    }
  };
