/// <reference types="node" />
import { config } from "dotenv";
config({ path: "../../.env" });

import { defineConfig } from "@prisma/config";

export default defineConfig({
    datasource: {
        url: process.env.MONGODB_URL!,
    },
});