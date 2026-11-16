import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
    {
        productId: {
            type: String,
            required: true,
            unique: true
        },

        name: {
            type: String,
            required: true
        },

        altNames: {
            type: [String],
            default: []
        },

        description: {
            type: String,
            required: true
        },

        images: {
            type: [String],
            default: [],
            required: true
        },

        price: {
            type: Number,
            min: 0,
            required: true
        },

        labelNo: {
            validate: { validator: Number.isInteger, message: "Stock must be a whole number" },
            type: Number,
            min: 0,
            required: true
        },

        category: {
            type: String,
            required: true
        }
    }
);

const Product = mongoose.model(
    "product",
    productSchema
);

export default Product;
