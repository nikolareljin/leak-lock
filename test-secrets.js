// Test file with example secrets for scanning
const apiKey = "sk_test_1234567890abcdef";
const password = "super_secret_password123";
const tokenValue = "ghp_1234567890abcdefghijklmnopqrstuvwxyz123456";

// Configuration with potential secrets
const config = {
    database: {
        host: "localhost",
        user: "admin",
        password: "admin123!@#",
        connectionString: "mongodb://admin:password@localhost:27017/mydb"
    },
    aws: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    },
    github: {
        token: "ghp_EXAMPLE1234567890abcdefghijklmnopqrstuvwxyz"
    }
};

console.log("This is a test file with example secrets");