import Product from "../models/product.js";
import { isAdmin } from "../controller/userController.js";


// ============================================================================
// CREATE PRODUCT
// ============================================================================

export async function createProduct(req, res) {

    // Admin ද බලනවා
    if (!isAdmin(req)) {

        return res.status(403).json({
            message: "You are not an admin"
        });

    }

    try {

        // Frontend එකෙන් එන product data
        const productData = req.body;




        // Product model එකෙන් අලුත් product එකක් හදනවා
        const product = new Product(productData);


        // MongoDB එකට save කරනවා
        await product.save();


        // Success response
        return res.status(201).json({

            message: "Product created Successfully",

            product: product

        });


    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: "Product ID already exists" });
        if (err.name === "ValidationError" || err.name === "CastError") return res.status(400).json({ message: "Invalid product details", error: err.message });

        // Actual error backend terminal එකේ බලන්න
        console.error("CREATE PRODUCT ERROR:");
        console.error(err);


        // Frontend එකටත් actual error message එක යවනවා
        return res.status(500).json({

            message: "Failed to create product",

            error: err.message

        });

    }

}



// ============================================================================
// GET ALL PRODUCTS
// ============================================================================

export async function getProducts(req, res) {

    try {

        const products = await Product.find();

        res.json(products);

    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: "Product ID already exists" });
        if (err.name === "ValidationError" || err.name === "CastError") return res.status(400).json({ message: "Invalid product details", error: err.message });

        console.error(err);

        res.status(500).json({

            message: "Faid to retriwe products"

        });

    }

}



// ============================================================================
// DELETE PRODUCT
// ============================================================================

export async function deletProducts(req, res) {

    if (!isAdmin(req)) {

        return res.status(403).json({

            message: "you not admin"

        });

    }


    try {

        const productId = req.params.productId;


        const result = await Product.deleteOne({

            productId: productId

        });


        if (result.deletedCount === 0) {

            return res.status(404).json({

                message: "Product not found"

            });

        }


        return res.json({

            message: "Product deleted Successfully"

        });


    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: "Product ID already exists" });
        if (err.name === "ValidationError" || err.name === "CastError") return res.status(400).json({ message: "Invalid product details", error: err.message });

        console.error(err);

        return res.status(500).json({

            message: "Failed to delete product"

        });

    }

}



// ============================================================================
// UPDATE PRODUCT
// ============================================================================

export async function updateProduct(req, res) {

    if (!isAdmin(req)) {

        res.status(403).json({

            message: "you not admin"

        });

        return;

    }


    try {

        const productId = req.params.productId;

        const productData = req.body;


        const result = await Product.updateOne(

            {
                productId: productId
            },

            { $set: Object.fromEntries(["name", "altNames", "description", "images", "price", "labelNo", "category"].filter(key => Object.hasOwn(productData, key)).map(key => [key, productData[key]])) },
            { runValidators: true }
        );
        if (!result.matchedCount) return res.status(404).json({ message: "Product not found" });


        res.json({

            message: "Product updated Successfully"

        });


    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: "Product ID already exists" });
        if (err.name === "ValidationError" || err.name === "CastError") return res.status(400).json({ message: "Invalid product details", error: err.message });

        console.error(err);

        res.status(500).json({

            message: "Failed to update product"

        });

    }

}



// ============================================================================
// GET ONE PRODUCT BY PRODUCT ID
// ============================================================================

export async function getProduct_Id(req, res) {

    try {

        const productId = req.params.productId;


        const product = await Product.findOne({

            productId: productId

        });


        if (product == null) {

            res.status(404).json({

                message: "Product Not Found"

            });

        } else {

            res.json(product);

        }


    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: "Product ID already exists" });
        if (err.name === "ValidationError" || err.name === "CastError") return res.status(400).json({ message: "Invalid product details", error: err.message });

        console.error(err);

        res.status(500).json({

            message: "Failed to retriwe product"

        });

    }

}