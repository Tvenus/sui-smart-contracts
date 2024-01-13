module yieldoptimizer::ysui {
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::coin;
    use sui::sui::SUI;
    use std::option;
    use yieldoptimizer::vault;

    struct YSUI has drop {}

    #[lint_allow(share_owned)]
    fun init(witness: YSUI, ctx: &mut TxContext) {
        let (treasury, meta) = coin::create_currency(
            witness, 9, b"ySUI", b"", b"", option::none(), ctx
        );
        transfer::public_share_object(meta);

        let admin_cap = vault::new<SUI, YSUI>(treasury, ctx);
        transfer::public_transfer(admin_cap, tx_context::sender(ctx));
    }
}