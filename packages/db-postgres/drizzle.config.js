export default {
    schema: "./src/schema.ts",
    out: "./drizzle",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.POSTGRES_URL
    }
};
//# sourceMappingURL=drizzle.config.js.map