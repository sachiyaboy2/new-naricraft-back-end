import express from "express";

import {createOrder,getOrders,updateOrderStatus,collectProductOrderBalance} from "../controller/orderController.js";


const orderRouter = express.Router();


orderRouter.post("/", createOrder);
orderRouter.get("/", getOrders);
orderRouter.put("/status/:orderId",updateOrderStatus);
orderRouter.put("/balance/:orderId",collectProductOrderBalance);


export default orderRouter;
