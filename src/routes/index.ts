import { Router } from "express";
import hodRoutes from "./hod.routes";
import lecturerRoutes from "./lecturer.routes";
import representativeRoutes from "./representative.routes";
import studentRoutes from "./student.routes";

const v1 = Router();
v1.use("/student", studentRoutes);
v1.use("/representative", representativeRoutes);
v1.use("/lecturer", lecturerRoutes);
v1.use("/hod", hodRoutes);
// Future: v1.use("/hod", ...), v1.use("/lecturer", ...), v1.use("/course-rep", ...)

export default v1;
