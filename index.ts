import { AzureFunction, Context } from "@azure/functions";
import amqp from "amqplib";

const timerTrigger: AzureFunction = async function (context: Context, myTimer: any): Promise<void> {
    const timeStamp = new Date().toISOString();
    context.log(`Timer trigger function executed at: ${timeStamp}`);

    // RabbitMQ connection details (use App Settings in Azure instead of local.settings.json in production)
    const rabbitUrl = process.env.RABBITMQ_URL || "amqp://localhost";
    const queueName = process.env.RABBITMQ_QUEUE || "defaultQueue";

    let connection;
    try {
        connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        await channel.assertQueue(queueName, { durable: true });
        context.log(`Connected to RabbitMQ and waiting for messages in queue: ${queueName}`);

        const messages: string[] = [];

        // Consume all messages available at the time of trigger
        await channel.consume(queueName, (msg) => {
            if (msg) {
                const content = msg.content.toString();
                context.log(`Message received: ${content}`);
                messages.push(content);
                channel.ack(msg);
            }
        }, { noAck: false });

        // Example: Forward to some other system (stub)
        if (messages.length > 0) {
            context.log(`Processing ${messages.length} messages...`);
            // TODO: Send messages to another system (e.g., AQS, Syslog, DB)
        }

        await channel.close();
    } catch (err) {
        context.log.error("RabbitMQ connection/processing failed:", err);
    } finally {
        if (connection) {
            await connection.close();
        }
    }
};

export default timerTrigger;
